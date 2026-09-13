import { isIP } from "node:net";

const directDigestPattern = /^sha256:[0-9a-f]{64}$/;
const repositoryComponentPattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const domainComponentPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const repositoryNameMaxLength = 255;
const dockerDefaultRegistries = new Set(["docker.io", "index.docker.io"]);

export function isImmutableImageReference(value: string): boolean {
  if (directDigestPattern.test(value)) return true;
  const named = value.match(/^(.+)@sha256:[0-9a-f]{64}$/);
  return named?.[1] !== undefined && isRepositoryName(named[1]);
}

function isRepositoryName(name: string): boolean {
  if (name.length === 0) return false;
  const components = name.split("/");
  if (components.some((component) => component.length === 0)) return false;

  // Docker 仅在首段具有 registry 特征时将其解释为域名，其余首段仍属于仓库路径。
  const first = components[0]!;
  const hasRegistry = components.length > 1
    && (first === "localhost" || first.includes(".") || first.includes(":") || first.startsWith("[") || /[A-Z]/.test(first));
  const repositoryComponents = hasRegistry ? components.slice(1) : components;
  const remoteName = repositoryComponents.join("/");
  const usesDefaultNamespace = !hasRegistry || dockerDefaultRegistries.has(first);
  const normalizedRemoteName = usesDefaultNamespace && repositoryComponents.length === 1
    ? `library/${remoteName}`
    : remoteName;
  return (!hasRegistry || isRegistry(first))
    && repositoryComponents.length > 0
    && normalizedRemoteName.length <= repositoryNameMaxLength
    && repositoryComponents.every((component) => repositoryComponentPattern.test(component));
}

function isRegistry(value: string): boolean {
  if (value.startsWith("[")) {
    const ipv6 = /^\[([^\]]+)\](?::[0-9]+)?$/.exec(value);
    return ipv6 !== null && /^[A-Fa-f0-9:]+$/.test(ipv6[1]!) && isIP(ipv6[1]!) === 6;
  }

  const separator = value.lastIndexOf(":");
  const host = separator === -1 ? value : value.slice(0, separator);
  const port = separator === -1 ? null : value.slice(separator + 1);
  if ((port !== null && !/^[0-9]+$/.test(port)) || host.length === 0 || host.includes(":")) return false;
  if (isIP(host) === 4) return true;
  return host.split(".").every((component) => domainComponentPattern.test(component));
}
