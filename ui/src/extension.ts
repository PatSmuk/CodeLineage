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
        shell: true,
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
      // Call the function to add red boxes above function definitions
      addRedBoxesAboveFunctions();
    }
  );
  context.subscriptions.push(disposable);
}
// Function to add red boxes above function definitions
async function addRedBoxesAboveFunctions() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const document = editor.document;
  const functionRegex = /func\s+\w+\s?\(.*\)\s*(\w|\W)/g;
  // Decorations for the red box
  const decorationType = vscode.window.createTextEditorDecorationType({
    borderWidth: "2px",
    borderStyle: "solid",
    borderColor: "red",
  });
  const functionPositions: vscode.Range[] = [];
  // Find all function definitions in the current document
  let match;
  while ((match = functionRegex.exec(document.getText()))) {
    const startPos = document.positionAt(match.index);
    const endPos = document.positionAt(match.index + match[0].length);
    // Add a decoration above the function definition (before the function start)
    const rangeAboveFunction = new vscode.Range(
      startPos.line - 1,
      0,
      startPos.line,
      0
    );
    functionPositions.push(rangeAboveFunction);
  }
  // Apply the red box decoration
  editor.setDecorations(decorationType, functionPositions);
}
