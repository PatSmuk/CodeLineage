import * as viz from "@viz-js/viz";
import * as path from "node:path";

export async function renderDotToHTML(
  dotContent: string,
  rootPath: string
): Promise<string> {
  const svgContent = (await viz.instance()).renderSVGElement(dotContent);
  const svgContentWithLinks = makeSVGClickable(rootPath, svgContent);

  return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <style>
            html, body {
              height: 100%;
            }
            .lineage-box {
              height: 100%;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              user-select: none;
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
              font-size: 18px;
              cursor: pointer;
              background-color: var(--vscode-button-secondaryBackground);
              border: 1px solid var(--vscode-button-border);
              border-radius: 2px;
              color: var(--vscode-button-secondaryForeground);
              transition: background-color 0.3s, color 0.3s;
            }
            #zoomIn {
              margin-bottom: 0;
              border-radius: 18px 18px 0 0;
            }
            #zoomOut {
              margin-top: 0;
              border-radius: 0 0 18px 18px;
            }
            .controls button:hover {
              background-color: var(--vscode-button-secondaryHoverBackground);
              color: var(--vscode-button-hoverForeground);
            }
            #svg-container {
              width: 100%;
              height: 100%;
            }
            svg {
              cursor: grab;
              overflow: hidden; /* Hide scrollbars */
              width: 100%;
              height: 100%;
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
            svg g.node:hover {
              filter: brightness(120%);
            }
            svg g.node.root path {
              stroke-width: 4px;
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

            // Calculate how much the SVG will be scaled initially to fit the web view's aspect ratio
            let scalingFactor = 0;
            {
              const containerWidth = container.clientWidth;
              const containerHeight = container.clientHeight;

              const viewBox = svg.getAttribute('viewBox');
              const [, , svgWidth, svgHeight] = viewBox.split(' ').map(Number);

              scalingFactor = (containerWidth / containerHeight) / (svgWidth / svgHeight);
            }

            let scale = 1;
            let panX = 0;
            let panY = 0;
            {
              const viewBox = svg.getAttribute('viewBox');
              const [, , svgWidth, svgHeight] = viewBox.split(' ').map(Number);

              const transform = svg.getScreenCTM().inverse();
              let pt = svg.createSVGPoint();
              pt.x = 0;
              pt.y = container.clientHeight / 2;
              pt = pt.matrixTransform(transform);
              panY = pt.y;
              panX = svgWidth / 2;
            }

            const updateTransform = () => {
              const containerWidth = container.clientWidth;
              const containerHeight = container.clientHeight;

              const viewBox = svg.getAttribute('viewBox');
              const [, , svgWidth, svgHeight] = viewBox.split(' ').map(Number);
              const centerX = svgWidth / 2;
              const centerY = svgHeight / 2;

              svgGroup.setAttribute(
                "transform",
                \`scale(\${scale}) translate(\${panX / scale} \${panY / scale}) translate(\${-centerX} \${centerY})\`
              );
            };
            updateTransform();

            // Zoom In and Out
            document.getElementById("zoomIn").addEventListener("click", () => {
              scale *= 1.5;
              updateTransform();
            });
            document.getElementById("zoomOut").addEventListener("click", () => {
              scale /= 1.5;
              updateTransform();
            });
            document.addEventListener("wheel", (e) => {
              scale *= Math.pow(1.05, -e.deltaY / 10);
              updateTransform();
            });

            // Dragging functionality
            let isDragging = false;
            let startX, startY;

            svg.addEventListener("mousedown", (e) => {
              isDragging = true;

              // Convert from the browser's coordinate system into the SVG's coordinate system
              const transform = svg.getScreenCTM().inverse();
              let pt = svg.createSVGPoint();
              pt.x = e.clientX;
              pt.y = e.clientY;
              pt = pt.matrixTransform(transform);
              startX = pt.x;
              startY = pt.y;

              svg.style.cursor = "grabbing";
            });

            window.addEventListener("mousemove", (e) => {
              if (!isDragging) return;

              // The difference calculations need to be done in the SVG's coordinate system,
              // otherwise it will move at a different speed than the mouse
              const transform = svg.getScreenCTM().inverse();
              let endPoint = svg.createSVGPoint();
              endPoint.x = e.clientX;
              endPoint.y = e.clientY;
              endPoint = endPoint.matrixTransform(transform);

              const dx = endPoint.x - startX;
              const dy = endPoint.y - startY;
              startX = endPoint.x;
              startY = endPoint.y;

              panX += dx;
              panY += dy;

              updateTransform();
            });

            window.addEventListener("mouseup", () => {
              isDragging = false;
              svg.style.cursor = "grab";
            });

            // Implement WASD + QE support
            const PAN_SPEED = 2 / scalingFactor;
            const keysPressed = new Set();
            let animationFrameId = null;

            function updatePan() {
              let shouldUpdate = false;

              if (keysPressed.has('w')) {
                panY += PAN_SPEED;
                shouldUpdate = true;
              }
              if (keysPressed.has('s')) {
                panY -= PAN_SPEED;
                shouldUpdate = true;
              }
              if (keysPressed.has('a')) {
                panX += PAN_SPEED;
                shouldUpdate = true;
              }
              if (keysPressed.has('d')) {
                panX -= PAN_SPEED;
                shouldUpdate = true;
              }
              if (keysPressed.has('q')) {
                scale /= 1.01;
                shouldUpdate = true;
              }
              if (keysPressed.has('e')) {
                scale *= 1.01;
                shouldUpdate = true;
              }

              if (shouldUpdate) {
                updateTransform();
              }

              // Continue animation if keys are still pressed
              if (keysPressed.size > 0) {
                animationFrameId = requestAnimationFrame(updatePan);
              } else {
                animationFrameId = null;
              }
            }

            function handleKeyDown(event) {
              const key = event.key.toLowerCase();
              if (['w', 'a', 's', 'd', 'e', 'q'].includes(key)) {
                keysPressed.add(key);

                // Start animation if not already running
                if (!animationFrameId) {
                  animationFrameId = requestAnimationFrame(updatePan);
                }
              }
            }

            function handleKeyUp(event) {
              const key = event.key.toLowerCase();
              keysPressed.delete(key);

              // If no keys are pressed, animation will stop naturally
            }

            // Add event listeners
            document.addEventListener('keydown', handleKeyDown);
            document.addEventListener('keyup', handleKeyUp);

            // Node Click Handling
            const vscode = acquireVsCodeApi();
            const nodes = svg.querySelectorAll("g[data-node-name]");
            for (const node of nodes) {
              node.addEventListener("mousedown", () => {
                const nodeName = node.getAttribute("data-node-name");
                const fileUri = node.getAttribute("data-file-uri");
                vscode.postMessage({ type: "nodeClick", nodeName, uri: fileUri });
              });
            }

            // Save SVG Button
            document.getElementById("save").addEventListener("click", () => {
              const title = svg.querySelector("title").innerHTML;
              const svgBlob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(svgBlob);
              link.download = title + ".svg";
              link.click();
            });
          </script>
        </body>
        </html>
      `;
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
