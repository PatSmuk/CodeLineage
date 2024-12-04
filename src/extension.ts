import { instance } from "@viz-js/viz";
import { spawn } from "child_process";
import { JSDOM } from "jsdom";
import * as path from "path";
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

  const lspProcess = spawn("gopls", {
    shell: true,
    stdio: "pipe",
  });

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
        const svgContentWithLinks = makeSVGClickable(rootPath, svgContent);
        const panel = vscode.window.createWebviewPanel(
          "lineageDetails",
          "Lineage of " + key.split("::")[1],
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
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 20px;
              }
              .controls {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 10;
                display: flex;
                flex-direction: column;
                align-items: center;
              }
              .controls button {
                margin: 5px 0; /* Keep space between buttons */
                padding: 10px;
                font-size: 14px;
                cursor: pointer;
                background-color: var(--vscode-button-background);
                border: 1px solid var(--vscode-button-border);
                border-radius: 5px;
                color: var(--vscode-button-foreground);
                transition: background-color 0.3s, color 0.3s;
              }
              .controls button:hover {
                background-color: var(--vscode-button-hoverBackground);
                color: var(--vscode-button-hoverForeground);
              }
              svg {
                border: 1px solid #ccc;
                cursor: grab;
                overflow: hidden; /* Hide scrollbars */
              }
              svg:active {
                cursor: grabbing;
              }
              svg g polygon {
                fill: var(--vscode-editor-background);
              }
              svg g.node path {
                fill: var(--vscode-button-background);
                stroke: var(--vscode-settings-sashBorder);
              }
              svg g.node text {
                fill: var(--vscode-button-foreground);
                font-family: var(--vscode-editor-font-family);
              }
              svg g.node text:last-child {
                opacity: 0.5;
              }
              svg g.edge path, svg g.edge polygon {
                stroke: var(--vscode-foreground);
              }
            </style>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
          </head>
          <body>
            <div class="lineage-box">
              <div id="svg-container">
                ${svgContentWithLinks.outerHTML}
              </div>
            </div>
            <div class="controls">
              <button id="zoomIn"><i class="fas fa-search-plus"></i></button>
              <button id="zoomOut"><i class="fas fa-search-minus"></i></button>
              <button id="save"><i class="fas fa-save"></i></button> <!-- Only Icon for Save -->
            </div>
            <script>
              const container = document.querySelector("#svg-container");
              const svg = container.querySelector("svg");
              const svgGroup = svg.querySelector("g");

              let scale = 1;
              let panX = 0;
              let panY = 0;

              const updateTransform = () => {
                svgGroup.setAttribute(
                  "transform",
                  \`translate(\${panX}, \${panY}) scale(\${scale})\`
                );
              };

              // Zoom In and Out
              document.getElementById("zoomIn").addEventListener("click", () => {
                scale *= 1.2;
                updateTransform();
              });
              document.getElementById("zoomOut").addEventListener("click", () => {
                scale /= 1.2;
                updateTransform();
              });

              // Dragging functionality
              let isDragging = false;
              let startX, startY;

              svg.addEventListener("mousedown", (e) => {
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                svg.style.cursor = "grabbing";
              });

              window.addEventListener("mousemove", (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                panX += dx;
                panY += dy;
                startX = e.clientX;
                startY = e.clientY;
                updateTransform();
              });

              window.addEventListener("mouseup", () => {
                isDragging = false;
                svg.style.cursor = "grab";
              });

              // Node Click Handling
              const vscode = acquireVsCodeApi();
              const nodes = svg.querySelectorAll("g[data-node-name]");
              nodes.forEach((node) => {
                node.addEventListener("click", () => {
                  const nodeName = node.getAttribute("data-node-name");
                  const fileUri = node.getAttribute("data-file-uri");
                  vscode.postMessage({ type: "nodeClick", nodeName, uri: fileUri });
                });
              });

              // Save SVG Button
              document.getElementById("save").addEventListener("click", () => {
                const svgBlob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
                const link = document.createElement("a");
                link.href = URL.createObjectURL(svgBlob);
                link.download = "call-graph.svg"; // Filename to save as
                link.click();
              });
            </script>
          </body>
          </html>
        `;

        panel.webview.onDidReceiveMessage(
          async (message) => {
            if (message.type === "nodeClick") {
              const fileUri = message.uri.split(":")[0];
              const line = parseInt(message.uri.split(":")[1] ?? 1) - 1;

              try {
                const document = await vscode.workspace.openTextDocument(
                  vscode.Uri.file(fileUri)
                );
                const editor = await vscode.window.showTextDocument(
                  document,
                  vscode.ViewColumn.One
                );
                const pos = new vscode.Position(line, 0);
                editor.selections = [new vscode.Selection(pos, pos)];
                editor.revealRange(new vscode.Range(pos, pos));
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

function makeSVGClickable(
  rootPath: string,
  svgElement: SVGElement
): SVGElement {
  const nodes = svgElement.querySelectorAll("g.node");

  for (const node of nodes) {
    const textElement = node.querySelectorAll("text")[1];
    if (textElement) {
      const nodeName = textElement.textContent || "";

      const fileUri = path.join(rootPath, nodeName);

      // Add attributes to store the necessary data
      node.setAttribute("data-node-name", nodeName);
      node.setAttribute("data-file-uri", fileUri);
      node.setAttribute("style", "cursor: pointer;");
    }
  }

  return svgElement;
}
