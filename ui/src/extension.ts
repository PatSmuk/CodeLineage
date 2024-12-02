import { spawn } from "child_process";
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "codelineage.analyzeGoCode",
    () => {
      // Get the root folder of the current workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("No workspace folder found");
        return;
      }

      const rootPath = workspaceFolders[0].uri.fsPath;

      // Spawn the Go process
      const process = spawn("codelineage-server", [rootPath], {
        cwd: rootPath, // Optional: set working directory
      });

      // Handle stdout
      process.stdout.on("data", (data) => {
        try {
          const jsonData = JSON.parse(data.toString());
          // Process the JSON response
          console.log("Received:", jsonData);
        } catch (error) {
          console.error("Error parsing JSON:", error);
        }
      });

      // Handle stderr
      process.stderr.on("data", (data) => {
        console.error(`Go process stderr: ${data}`);
      });

      // Handle process exit
      process.on("close", (code) => {
        console.log(`Go process exited with code ${code}`);
      });

      process.stdin.write('{"requestId": 99, "type": "FOO"}\n');
    }
  );

  context.subscriptions.push(disposable);
}
