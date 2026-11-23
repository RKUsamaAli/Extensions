// Renders static/brand/*.svg to the PNG sizes the manifest and stores need.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const big = readFileSync("static/brand/icon.svg", "utf8");
const small = readFileSync("static/brand/icon-small.svg", "utf8");
const render = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

mkdirSync("static/icons", { recursive: true });
// 16 and 32 use the simplified drawing so the toolbar icon stays crisp.
for (const [size, svg] of [[16, small], [32, small], [48, big], [128, big]]) {
  writeFileSync(`static/icons/icon${size}.png`, render(svg, size));
}
// Larger copies for the store listing and previews (not shipped in the zip).
mkdirSync("store", { recursive: true });
writeFileSync("store/icon512.png", render(big, 512));
console.log("icons written");
