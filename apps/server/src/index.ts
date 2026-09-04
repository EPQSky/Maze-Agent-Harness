import { resolve } from "node:path";
import { Socket } from "node:net";
import { createArenaServer, installPersistentShutdownHandlers } from "./app.js";
import { createProductionHarnessAdapter } from "./production-harness.js";
import { DockerMatchProfileCommandFactory, HarnessMatchProfileInstaller, NativePluginMatchRunner } from "@maze-arena/match-profile";
import { isSensitiveProviderOptionName } from "@maze-arena/contracts";
import type { FastifyRequest } from "fastify";

interface StartupIdentity {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  port: number;
}

function readStartupCommit(channel: Socket, identity: StartupIdentity, timeout = 10_000): Promise<void> {
  return new Promise((resolveCommit, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      channel.off("data", onData);
      channel.off("end", onEnd);
      channel.off("error", onError);
      channel.off("close", onClose);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (message: string) => finish(() => reject(new Error(message)));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024) {
        fail("生产启动确认超过 8 KiB 限制");
        return;
      }
      chunks.push(chunk);
      const payload = Buffer.concat(chunks);
      const newline = payload.indexOf(0x0a);
      if (newline < 0) return;
      if (payload.subarray(newline + 1).length !== 0) {
        fail("生产启动确认结构无效");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(payload.subarray(0, newline).toString("utf8"));
      } catch {
        fail("生产启动确认结构无效");
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("生产启动确认结构无效");
        return;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.join("\n") !== ["instanceId", "phase", "pid", "port", "schemaVersion"].sort().join("\n")
        || record.schemaVersion !== 1 || record.phase !== "commit" || record.instanceId !== identity.instanceId
        || record.pid !== identity.pid || record.port !== identity.port) {
        fail("生产启动确认身份无效");
        return;
      }
      finish(resolveCommit);
    };
    const onEnd = () => fail("生产启动确认前父进程通道已关闭");
    const onError = () => fail("生产启动确认通道失败");
    const onClose = () => fail("生产启动确认前父进程通道已关闭");
    const deadline = setTimeout(() => fail("生产启动确认超时"), timeout);
    channel.on("data", onData);
    channel.once("end", onEnd);
    channel.once("error", onError);
    channel.once("close", onClose);
  });
}

function writeStartupFrame(channel: Socket, value: object): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > 8 * 1024) return Promise.reject(new Error("生产启动协议帧超过 8 KiB 限制"));
  return new Promise((resolveWrite, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      channel.off("error", onError);
      callback();
    };
    const onError = () => finish(() => reject(new Error("生产启动协议帧写入失败")));
    channel.once("error", onError);
    channel.write(frame, (error) => {
      if (error) finish(() => reject(new Error("生产启动协议帧写入失败")));
      else finish(resolveWrite);
    });
  });
}

function sanitizedMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /(api.?key|authorization|credential|password|secret|token)/i.test(name)) {
      message = message.split(value).join("[REDACTED]");
    }
  }
  return message
    .replace(/\b(?:sk|key|token|secret|password)[-_][A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
}

function sanitizedRequestUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://maze-arena.local");
    const rawPath = url.split("?", 1)[0] ?? "/";
    let sanitizedPath: string;
    try {
      const decodedPath = decodeURIComponent(parsed.pathname);
      sanitizedPath = rawPath.includes("%") || decodedPath.includes("%") || decodedPath.includes("\uFFFD")
        ? "/[REDACTED-PATH]"
        : sanitizedMessage(decodedPath);
    } catch {
      sanitizedPath = "/[REDACTED-PATH]";
    }
    const rawQuery = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    if (rawQuery.includes(";") || /%(?![0-9a-f]{2})/i.test(rawQuery)) return sanitizedPath;
    const sanitizedQuery = new URLSearchParams();
    for (const [name, value] of parsed.searchParams) {
      // 二次编码、分号伪分隔和无效 UTF-8 都存在解释分歧；关闭失败并丢弃完整查询串。
      if (name.includes("%") || value.includes("%") || name.includes(";") || value.includes(";")
        || name.includes("\uFFFD") || value.includes("\uFFFD")) return sanitizedPath;
      sanitizedQuery.append(name, isSensitiveProviderOptionName(name) ? "[REDACTED]" : sanitizedMessage(value));
    }
    const serializedQuery = sanitizedQuery.toString().replace(/%5BREDACTED%5D/gi, "[REDACTED]");
    const query = serializedQuery ? `?${serializedQuery}` : "";
    return `${sanitizedPath}${query}`;
  } catch {
    // 无法可靠解析时不保留任何查询内容，避免原始秘密随诊断日志泄漏。
    return sanitizedMessage(url.split("?", 1)[0] ?? "/");
  }
}

async function main(): Promise<void> {
  const databasePath = resolve(process.env.ARENA_DATABASE_PATH ?? ".data/maze-arena.sqlite");
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const startupHandshakeFd = process.env.ARENA_STARTUP_HANDSHAKE_FD === undefined
    ? undefined
    : Number(process.env.ARENA_STARTUP_HANDSHAKE_FD);
  const harnessAdapter = createProductionHarnessAdapter(process.env);
  const matchImage = process.env.ARENA_MATCH_IMAGE;
  const trustedRoot = process.env.ARENA_MATCH_TRUSTED_ROOT;
  const protocolBundle = process.env.ARENA_MATCH_PROTOCOL_PACKAGE;
  const generatorPlugin = process.env.ARENA_GENERATOR_PLUGIN_PACKAGE;
  const solverPlugin = process.env.ARENA_SOLVER_PLUGIN_PACKAGE;
  const webRoot = process.env.ARENA_WEB_ROOT;
  const dshExecutable = process.env.DSH_EXECUTABLE ?? "dsh";
  const harnessRuntimeRoot = process.env.DSH_HARNESS_RUNTIME_ROOT;
  const harnessRuntimePayloadSha256 = process.env.DSH_HARNESS_RUNTIME_SHA256;
  const harnessVersion = process.env.DSH_HARNESS_VERSION;
  if (!Number.isSafeInteger(port) || (port !== 0 && (port < 1_024 || port > 65_535))) throw new Error("生产监听端口无效");
  if (startupHandshakeFd !== undefined && startupHandshakeFd !== 3) throw new Error("生产启动握手描述符无效");
  if (port === 0 && startupHandshakeFd === undefined) throw new Error("自动监听端口需要生产启动握手描述符");
  if (!matchImage || !trustedRoot || !protocolBundle || !generatorPlugin || !solverPlugin || !harnessVersion || !webRoot
    || !harnessRuntimeRoot || !harnessRuntimePayloadSha256) {
    throw new Error("生产启动必须配置摘要锁定的 Match Profile 镜像、隔离 Harness home、三个 bundle 包路径与 Web 构建目录");
  }
  await new HarnessMatchProfileInstaller({
    executable: dshExecutable,
    runtimeRoot: harnessRuntimeRoot,
    runtimePayloadSha256: harnessRuntimePayloadSha256,
    expectedVersion: harnessVersion,
    home: trustedRoot,
    protocolBundle,
    roleBundles: { generator: generatorPlugin, solver: solverPlugin },
  }).prepare();
  const matchRunner = new NativePluginMatchRunner(new DockerMatchProfileCommandFactory(matchImage, trustedRoot));
  let startupCommitted = startupHandshakeFd === undefined;
  const server = createArenaServer({
    databasePath,
    harnessRoot: trustedRoot,
    harnessAdapter,
    matchRunner,
    webRoot,
    startupCommitted: () => startupCommitted,
    logger: {
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: sanitizedRequestUrl(request.url),
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        }),
        err: (error: Error) => ({
          type: error.name,
          message: sanitizedMessage(error),
          stack: sanitizedMessage(error.stack ?? `${error.name}: ${error.message}`),
        }),
      },
    },
  });
  const shutdown = installPersistentShutdownHandlers(
    () => server.close().then(() => undefined),
    (error) => {
      process.stderr.write(`生产服务安全关闭失败：${sanitizedMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
  await server.listen({ port, host: "127.0.0.1" });
  if (startupHandshakeFd !== undefined) {
    const startupChannel = new Socket({ fd: startupHandshakeFd, readable: true, writable: true });
    try {
      const address = server.server.address();
      if (!address || typeof address === "string" || address.port < 1_024 || address.port > 65_535) {
        throw new Error("生产 Server 实际监听端口无效");
      }
      const identity: StartupIdentity = {
        schemaVersion: 1,
        instanceId: process.env.ARENA_INSTANCE_ID ?? "",
        pid: process.pid,
        port: address.port,
      };
      await writeStartupFrame(startupChannel, { ...identity, phase: "ready" });
      await readStartupCommit(startupChannel, identity);
      await writeStartupFrame(startupChannel, { ...identity, phase: "committed" });
      startupCommitted = true;
    } catch (error) {
      startupChannel.destroy();
      await shutdown.begin();
      throw error;
    } finally {
      startupChannel.destroy();
    }
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`生产服务失败：${sanitizedMessage(error)}\n`);
  process.exitCode = 1;
}
