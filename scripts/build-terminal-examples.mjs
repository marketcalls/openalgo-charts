import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const sources = ['examples/sample-feed.ts', 'examples/dockview/src/ChartPanel.ts', 'examples/dockview/src/TerminalApp.ts'];

// Browser entries use built tier files; relative TypeScript imports need explicit extensions.
for (const source of sources) {
  const filename = resolve(root, source);
  const imports = context => node => ts.visitNode(node, function visit(item) {
    if (ts.isImportDeclaration(item) && ts.isStringLiteral(item.moduleSpecifier)) {
      let specifier = item.moduleSpecifier.text;
      if (specifier.endsWith('.css')) return undefined; // The example HTML owns its stylesheet.
      if (specifier === 'openalgo-charts' || specifier.startsWith('openalgo-charts/')) {
        const tier = specifier === 'openalgo-charts' ? '' : `.${specifier.slice('openalgo-charts/'.length)}`;
        specifier = relative(dirname(filename), resolve(root, `dist/openalgo-charts${tier}.mjs`)).replaceAll('\\', '/');
        if (!specifier.startsWith('.')) specifier = `./${specifier}`;
      } else if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) specifier += '.js';
      return context.factory.updateImportDeclaration(item, item.modifiers, item.importClause,
        context.factory.createStringLiteral(specifier), item.attributes);
    }
    return ts.visitEachChild(item, visit, context);
  });
  const result = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true, transformers: { before: [imports] },
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true, verbatimModuleSyntax: true },
  });
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n',
  }));
  writeFileSync(filename.replace(/\.ts$/, '.js'), result.outputText);
}
console.log(`Built ${sources.length} terminal example modules from TypeScript.`);
