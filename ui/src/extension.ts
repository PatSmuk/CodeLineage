import { instance } from "@viz-js/viz";
import { spawn } from "child_process";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { LineageCodeLensProvider } from "./LineageCodeLensProvider";
import { JSONRPCEndpoint, LspClient } from "./ts-lsp-client";

let rootPath: string = "";
global.DOMParser = new JSDOM().window.DOMParser;

let lspClient: LspClient | null = null;
const graphvizMap = new Map<string, string>();

export async function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "codelineage.analyzeGoCode",
    () => {}
  );
  context.subscriptions.push(disposable);

  // Get the root folder of the current workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder found");
    return;
  }
  rootPath = workspaceFolders[0].uri.fsPath;

  const lspProcess = spawn(
    "gopls",
    [
      // "-logfile=/Users/pat.smuk/Code/github.com/PatSmuk/CodeLineage/ui/gopls-trace.log",
      // "-rpc.trace",
    ],
    {
      shell: true,
      stdio: "pipe",
    }
  );

  const endpoint = new JSONRPCEndpoint(lspProcess.stdin, lspProcess.stdout);
  lspClient = new LspClient(endpoint);

  await lspClient.initialize({
    processId: process.pid,
    capabilities: {},
    clientInfo: {
      name: "CodeLineage",
      version: "1.0.0",
    },
    rootUri: workspaceFolders[0].uri.toString(),
  });

  await lspClient.initialized();

  // Clean up server process if extension is deactivated.
  context.subscriptions.push(
    new vscode.Disposable(() => {
      lspProcess.kill();
    })
  );

  // Register the CodeLens provider
  const selector: vscode.DocumentSelector = { language: "go" };
  disposable = vscode.languages.registerCodeLensProvider(
    selector,
    new LineageCodeLensProvider(lspClient, graphvizMap, rootPath)
  );
  context.subscriptions.push(disposable);

  // Command to handle custom styling
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeLineage.showCallGraph",
      async (key: string) => {
        const dotContent = graphvizMap.get(key);
        if (!dotContent) {
          return;
        }
        const svgContent = await instance().then((viz) => {
          return viz.renderSVGElement(dotContent);
        });
        const panel = vscode.window.createWebviewPanel(
          "lineageDetails",
          "Lineage",
          vscode.ViewColumn.Beside,
          {}
        );
        panel.webview.html = `
            <div class="lineage-box">
              ${svgContent.outerHTML}
            </div>
        `;
      }
    )
  );
}
