// Locate the Python interpreter inside the project's ./pyenv environment.
// Layouts: venv on macOS/Linux -> bin/python, venv on Windows -> Scripts\python.exe,
// conda env on Windows -> python.exe at the env root.
import fs from "node:fs";
import path from "node:path";

export function envPython(root) {
  const env = path.join(root, "pyenv");
  const candidates =
    process.platform === "win32"
      ? [path.join(env, "Scripts", "python.exe"), path.join(env, "python.exe")]
      : [path.join(env, "bin", "python"), path.join(env, "bin", "python3")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}
