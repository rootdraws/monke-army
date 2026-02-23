import { rootNodeFromAnchorWithoutDefaultVisitor } from "@codama/nodes-from-anchor";
import { renderJavaScriptVisitor } from "@codama/renderers";
import { visit } from "@codama/visitors-core";
import { readFileSync } from "fs";

const idls = [
  { name: "bin_farm", path: "bot/idl/bin_farm.json", dir: "src/generated/bin-farm" },
  { name: "monke_bananas", path: "bot/idl/monke_bananas.json", dir: "src/generated/monke-bananas" },
];

for (const { name, path, dir } of idls) {
  console.log(`Generating ${name} client from ${path}...`);
  const idl = JSON.parse(readFileSync(path, "utf-8"));
  const node = rootNodeFromAnchorWithoutDefaultVisitor(idl);
  await visit(node, await renderJavaScriptVisitor(dir));
  console.log(`  -> ${dir}/`);
}

console.log("Done.");
