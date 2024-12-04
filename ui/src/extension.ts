import { instance } from "@viz-js/viz";
import { spawn } from "child_process";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { LineageCodeLensProvider } from "./LineageCodeLensProvider";
import { JSONRPCEndpoint, LspClient } from "./ts-lsp-client";

// Used by the viz-js to render the SVG.
global.DOMParser = new JSDOM().window.DOMParser;

const graphvizMap = new Map<string, string>();

let lspClient: LspClient | null = null;
let analysisEnabled = true;
const getLspClient = () => (analysisEnabled ? lspClient : null);

export async function activate(context: vscode.ExtensionContext) {
  // Get the root folder of the current workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder found");
    return;
  }
  const rootPath = workspaceFolders[0].uri.fsPath;

  const codeLensProvider = new LineageCodeLensProvider(
    getLspClient,
    graphvizMap,
    rootPath
  );

  let disposable = vscode.commands.registerCommand("codelineage.start", () => {
    analysisEnabled = true;
    codeLensProvider.notify();
  });
  context.subscriptions.push(disposable);

  disposable = vscode.commands.registerCommand("codelineage.stop", () => {
    analysisEnabled = false;
    codeLensProvider.notify();
  });
  context.subscriptions.push(disposable);

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
    codeLensProvider
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
        const svgContentWithLinks = makeSVGClickable(svgContent);
        const panel = vscode.window.createWebviewPanel(
          "lineageDetails",
          "Lineage",
          vscode.ViewColumn.Beside,
          {
            enableScripts: true, // Enable JavaScript execution
          }
        );
        panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <style>
            .lineage-box {
              display: flex;
              justify-content: center;
              align-items: center;
              padding: 20px;
            }
            svg {
              width: 100%;
              height: auto;
            }
          </style>
        </head>
        <body>
          <div class="lineage-box">
            ${svgContentWithLinks.outerHTML}
          </div>
          <script>
            window.addEventListener("DOMContentLoaded", () => {
              const vscode = acquireVsCodeApi();
              const nodes = document.querySelectorAll("g[data-node-name]");
              nodes.forEach((node) => {
                node.addEventListener("click", () => {
                  const nodeName = node.getAttribute("data-node-name");
                  const fileUri = node.getAttribute("data-file-uri");
                  vscode.postMessage({ type: "nodeClick", nodeName, uri: fileUri });
                });
              });
            });
          </script>
        </body>
        </html>
        `;

        panel.webview.onDidReceiveMessage(
          async (message) => {
            console.log(message);
            if (message.type === "nodeClick") {
              const nodeName = message.nodeName;
              const fileUri = message.uri;

              try {
                console.log("Trying to open " + fileUri);
                const document = await vscode.workspace.openTextDocument(
                  vscode.Uri.file(fileUri)
                );
                vscode.window.showTextDocument(document, vscode.ViewColumn.One);
              } catch (error) {
                vscode.window.showErrorMessage(`Failed to open file: ${error}`);
              }
            }
          },
          undefined,
          context.subscriptions
        );
      }
    )
  );
}

function makeSVGClickable(svgElement: SVGElement): SVGElement {
  const nodes = svgElement.querySelectorAll("g.node");

  nodes.forEach((node) => {
    const titleElement = node.querySelector("title");
    if (titleElement) {
      const nodeName = titleElement.textContent || "";

      // Assuming the file URI is stored or can be derived
      const fileUri =
        "/Users/marco.martin/go/src/impression/cmd/impression/server/server.go";
      // const fileUri = `file://path/to/${nodeName}.go`; // Replace with actual logic

      // Add attributes to store the necessary data
      node.setAttribute("data-node-name", nodeName);
      node.setAttribute("data-file-uri", fileUri);
      node.setAttribute("style", "cursor: pointer;");
    }
  });

  return svgElement;
}
