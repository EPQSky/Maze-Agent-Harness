const environmentNamePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const credentialNamePattern = /^(?:[A-Z][A-Z0-9]*_)+(?:API_KEY|CRED)$/;

// 整个命名空间由正式运行链或常见工具解释，不能通过新增变量名绕过策略。
const reservedRuntimeNamespaces = [
  "ALL_", "ARENA_", "BASH_", "BUN_", "CONTAINER_", "COREPACK_", "CURL_", "DENO_", "DOCKER_",
  "DSH_", "DYLD_", "ENV_", "GIT_", "HOME_", "HTTP_", "HTTPS_", "IFS_", "LANG_", "LC_", "LD_",
  "MAZE_ARENA_", "NODE_", "NO_", "NPM_", "OPENSSL_", "PATH_", "PNPM_", "REQUESTS_", "SHELL_",
  "SSH_", "SSL_", "TMPDIR_", "TZ_", "UV_", "V8_", "XDG_", "YARN_", "ZSH_",
] as const;

export function credentialEnvironmentNameIssue(name: string): string | undefined {
  if (!environmentNamePattern.test(name)) return "凭据环境变量名必须是 POSIX_NAME";
  if (reservedRuntimeNamespaces.some((prefix) => name.startsWith(prefix))) {
    return "禁止把进程或运行控制变量登记为凭据";
  }
  if (!credentialNamePattern.test(name)) return "凭据环境变量名必须以 _API_KEY 或 _CRED 结尾";
  return undefined;
}

export function credentialEnvironmentNameFromReference(reference: string): string {
  const prefix = "dsh-credential://";
  const name = reference.startsWith(prefix) ? reference.slice(prefix.length) : "";
  const issue = credentialEnvironmentNameIssue(name);
  if (issue) throw new Error(issue);
  return name;
}
