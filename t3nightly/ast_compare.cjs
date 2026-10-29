const fs = require("node:fs");
const [typescript, mode, before, after] = process.argv.slice(2);
const ts = require(typescript);
const PRAGMA = /^PRAGMA (?:busy_timeout|cache_size|temp_store|mmap_size) = \d+;?$/;

function forkCall(node) {
  return ts.isExpressionStatement(node) && ts.isYieldExpression(node.expression) && node.expression.asteriskToken && node.expression.expression
    && ts.isCallExpression(node.expression.expression) && ts.isIdentifier(node.expression.expression.expression)
    && node.expression.expression.expression.text === "runForkMigrations" && !node.expression.expression.arguments.length && !node.expression.expression.typeArguments;
}

function inRunMigrations(node) {
  const body = node.parent;
  if (!body || !ts.isBlock(body)) return false;
  const generator = body.parent;
  if (!generator || !ts.isFunctionExpression(generator) || !generator.asteriskToken || generator.body !== body) return false;
  const call = generator.parent;
  if (!call || !ts.isCallExpression(call)) return false;
  const factory = call.expression;
  return ts.isCallExpression(factory) && ts.isPropertyAccessExpression(factory.expression) && ts.isIdentifier(factory.expression.expression)
    && factory.expression.expression.text === "Effect" && factory.expression.name.text === "fn" && factory.arguments.length === 1
    && ts.isStringLiteral(factory.arguments[0]) && factory.arguments[0].text === "runMigrations";
}

function hook(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    return ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./ForkMigrations.ts" && clause && !clause.isTypeOnly && !clause.name
      && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length === 1
      && !clause.namedBindings.elements[0].propertyName && !clause.namedBindings.elements[0].isTypeOnly && clause.namedBindings.elements[0].name.text === "runForkMigrations";
  }
  if (!inRunMigrations(node)) return false;
  if (forkCall(node)) return true;
  return ts.isIfStatement(node) && !node.elseStatement && forkCall(node.thenStatement) && ts.isBinaryExpression(node.expression)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.expression.operatorToken.kind)
    && ts.isIdentifier(node.expression.left) && ts.isIdentifier(node.expression.right) && node.expression.right.text === "undefined";
}

function pragma(node) {
  if (!ts.isExpressionStatement(node)) return false;
  const value = node.expression;
  if (!ts.isYieldExpression(value) || !value.asteriskToken || !value.expression) return false;
  const tagged = value.expression;
  return ts.isTaggedTemplateExpression(tagged) && !tagged.typeArguments && ts.isIdentifier(tagged.tag) && tagged.tag.text === "sql"
    && ts.isNoSubstitutionTemplateLiteral(tagged.template) && tagged.template.rawText === tagged.template.text && PRAGMA.test(tagged.template.text) && bound(node);
}

function declaresSql(statement) {
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => client(declaration));
}

function bound(node) {
  const scope = node.parent;
  if (!scope || !(ts.isBlock(scope) || ts.isSourceFile(scope))) return false;
  const index = scope.statements.indexOf(node);
  return index > 0 && scope.statements.slice(0, index).some(declaresSql);
}

function client(node) {
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "sql" && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)
    && node.initializer && ts.isYieldExpression(node.initializer) && node.initializer.asteriskToken && node.initializer.expression
    && ts.isPropertyAccessExpression(node.initializer.expression) && ts.isIdentifier(node.initializer.expression.expression)
    && node.initializer.expression.expression.text === "SqlClient" && node.initializer.expression.name.text === "SqlClient";
}

function namespace(node) {
  return ts.isNamespaceImport(node) && ts.isImportClause(node.parent) && !node.parent.isTypeOnly
    && ts.isStringLiteral(node.parent.parent.moduleSpecifier) && node.parent.parent.moduleSpecifier.text === "effect/sql/SqlClient";
}

function forkImport(node) {
  return ts.isImportSpecifier(node) && hook(node.parent.parent.parent);
}

const RULES = {
  pragma: { strip: pragma, names: { sql: client, SqlClient: namespace }, required: ["sql", "SqlClient"] },
  hook: { strip: hook, names: { runForkMigrations: forkImport }, required: ["runForkMigrations"] },
};

function normalized(path, rule) {
  const source = ts.createSourceFile(path, fs.readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error(`${path} does not parse`);
  const declared = new Set();
  const check = (node) => {
    if (ts.isIdentifier(node) && node.parent && ts.isDeclaration(node.parent) && node.parent.name === node && Object.hasOwn(rule.names, node.text)) {
      if (!rule.names[node.text](node.parent)) throw new Error(`${path} rebinds ${node.text}`);
      declared.add(node.text);
    }
    ts.forEachChild(node, check);
  };
  check(source);
  let removed = 0;
  const strip = (context) => (root) => {
    const visit = (node) => {
      if (rule.strip(node)) {
        removed += 1;
        return undefined;
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit);
  };
  const result = ts.transform(source, [strip]);
  const text = ts.createPrinter({ removeComments: true }).printFile(result.transformed[0]);
  result.dispose();
  if (removed && !rule.required.every((name) => declared.has(name))) throw new Error(`${path} strips unbound statements`);
  return { text, removed };
}

try {
  const rule = RULES[mode];
  const old = normalized(before, rule);
  const updated = normalized(after, rule);
  process.stdout.write(old.text === updated.text && old.removed + updated.removed > 0 ? "same" : "differ");
} catch (error) {
  process.stdout.write("error");
}
