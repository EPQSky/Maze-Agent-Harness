import { existsSync, unlinkSync, writeFileSync } from "node:fs";

const [action, marker, mode] = process.argv.slice(2);
if (action === "remove") {
  if (mode === "permission") {
    process.stderr.write("permission denied while connecting to the Docker daemon\n");
    process.exit(2);
  }
  writeFileSync(`${marker}.removed`, "removed");
  if (mode === "removing" && !existsSync(`${marker}.attempted`)) {
    writeFileSync(`${marker}.attempted`, "automatic removal already started");
    if (existsSync(marker)) unlinkSync(marker);
    process.stderr.write("Error response from daemon: removal of container controlled is already in progress\n");
    process.exit(1);
  }
  if (mode === "race" && !existsSync(`${marker}.attempted`)) {
    writeFileSync(`${marker}.attempted`, "first remove raced with create");
    process.exit(0);
  }
  if (existsSync(marker)) unlinkSync(marker);
} else if (action === "inspect") {
  if (mode === "daemon") {
    process.stderr.write("Cannot connect to the Docker daemon\n");
    process.exit(2);
  }
  if (!existsSync(marker)) {
    process.stderr.write("Error: No such object\n");
    process.exit(1);
  }
} else if (action === "pid") {
  process.stdout.write(`${marker}\n`);
} else {
  process.exit(2);
}
