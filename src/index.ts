import * as fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { createGenerateCommentsChain } from "./generate_comments_chain.js";

const directoryPath = process.argv[2];

if (!directoryPath) {
  throw new Error("No directory path provided.")
}

const walk = (dirPath) => {
  if (fs.statSync(dirPath).isFile()) {
    return [dirPath];
  }
  const entries = fs.readdirSync(dirPath, {withFileTypes: true});
  return entries.map((entry) => {
    const childPath = path.join(dirPath, entry.name)
    return entry.isDirectory() ? walk(childPath) : childPath
  })
};

const filePaths = (await walk(directoryPath)).flat(Number.POSITIVE_INFINITY).filter((filePath) => {
  if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) {
    return false;
  }
  const sourceNode = ts.createSourceFile("dummy.ts", fs.readFileSync(filePath).toString(), ts.ScriptTarget.Latest, true);
  const relevantNode = findMatchingUncommentedDeclarationNode(sourceNode);
  if (!relevantNode) {
    console.log("Skipping file", filePath);
  }
  return !!relevantNode;
});

function findMatchingUncommentedDeclarationNode(
  rootNode: ts.SourceFile,
  nodeName?: string,
  nodeType?: "method" | "class" | "interface" | "type" | "function"
): ts.MethodDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined {
  let foundNode;
  const rootNodeFullText = rootNode.getFullText();
  function _findDeclarations(node: ts.Node) {
    if (
      (
        ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && (!nodeType || nodeType === "method" || nodeType === "function")) ||
        (ts.isClassDeclaration(node) && (!nodeType || nodeType === "class")) ||
        (ts.isInterfaceDeclaration(node) && (!nodeType || nodeType === "interface")) ||
        (ts.isTypeAliasDeclaration(node) && (!nodeType || nodeType === "type"))
      ) && (!nodeName || (nodeName === node.name.getText()))
    ) {
      if (
        !rootNodeFullText.slice(node?.getStart(rootNode, true), node?.getEnd()).startsWith("/*") &&
        !rootNodeFullText.slice(node?.getStart(rootNode, true), node?.getEnd()).startsWith("//") &&
        !node.name.getText().startsWith("lc_") &&
        !node.name.getText().startsWith("_") &&
        node.name.getText() !== "serialize" &&
        node.name.getText() !== "deserialize"
      ) {
        foundNode = node;
      }
    }
    if (!foundNode) {
      ts.forEachChild(node, _findDeclarations);
    }
  };
  _findDeclarations(rootNode);
  return foundNode;
}

for (const filePath of filePaths) {
  console.log("Adding comments for", filePath)
  const chain = await createGenerateCommentsChain();
  const rawCode = fs.readFileSync(filePath).toString();
  const result = await chain.invoke({
    input: rawCode
  });
  const comments = result.ts_doc_comments;
  let updatedCode = rawCode;
  for (const comment of comments) {
    const sourceNode = ts.createSourceFile("dummy.ts", updatedCode, ts.ScriptTarget.Latest, true);
    console.log("Searching for", comment.name, "in", filePath);
    const declarationNode = findMatchingUncommentedDeclarationNode(sourceNode, comment.name, comment.type);
    if (declarationNode) {
      console.log("Splicing comment for", declarationNode.name.getText(), "in", filePath);
      const commentLines = comment.text.split(" ").reduce((lines: string[], word) => {
        if (!lines.length) {
          lines.push(word);
        } else {
          if (lines[lines.length - 1].length + word.length > 70) {
            lines.push(word);
          } else {
            lines[lines.length - 1] = lines[lines.length - 1] + " " + word;
          }
        }
        return lines;
      }, []);
      const extraLines = comment.type === "method" ? comment.params.map((param) => {
        return `@param ${param.name} ${param.description}`;
      }) : [];
      if (comment.returns && comment.type === "method") {
        extraLines.push(`@returns ${comment.returns}`);
      }
      const commentString = ["/**", ...commentLines, ...extraLines].join("\n * ") + "\n */";
      updatedCode = updatedCode.slice(0, declarationNode.getStart()) + commentString + "\n" + updatedCode.slice(declarationNode.getStart())
    }
  }
  fs.writeFileSync(filePath, updatedCode);
}
