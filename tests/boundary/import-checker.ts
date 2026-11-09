import ts from 'typescript';

/** Every module specifier in a file, including type-only, re-export and dynamic forms. */
export function collectSpecifiers(path: string, text: string): { specifiers: string[]; nonLiteral: number } {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specifiers: string[] = [];
  let nonLiteral = 0;
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.push(node.text);
    else nonLiteral += 1;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) literal(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) literal(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      literal(ts.isLiteralTypeNode(arg) ? arg.literal : undefined);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, nonLiteral };
}
