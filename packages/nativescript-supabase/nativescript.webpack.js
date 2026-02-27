const { resolve } = require('path');
const { transformSync } = require('@babel/core');
const { Compilation, sources } = require('webpack');

function hasTypeofWindow(node) {
	if (!node || typeof node !== 'object') {
		return false;
	}

	if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument?.type === 'Identifier' && node.argument.name === 'window') {
		return true;
	}

	const keys = Object.keys(node);
	for (const key of keys) {
		const value = node[key];
		if (Array.isArray(value)) {
			if (value.some((item) => hasTypeofWindow(item))) {
				return true;
			}
			continue;
		}

		if (hasTypeofWindow(value)) {
			return true;
		}
	}

	return false;
}

function transformIsBrowser(source) {
	const result = transformSync(source, {
		babelrc: false,
		configFile: false,
		sourceType: 'unambiguous',
		plugins: [
			({ types: t }) => ({
				name: 'supabase-is-browser-override',
				visitor: {
					VariableDeclarator(path) {
						if (!t.isIdentifier(path.node.id, { name: 'isBrowser' })) {
							return;
						}

						const initializer = path.node.init;
						if (!initializer || (!t.isArrowFunctionExpression(initializer) && !t.isFunctionExpression(initializer))) {
							return;
						}

						if (initializer.params.length > 0) {
							return;
						}

						const body = initializer.body;
						const returnedExpression = t.isBlockStatement(body) ? body.body.find((statement) => t.isReturnStatement(statement))?.argument : body;

						if (!returnedExpression || !hasTypeofWindow(returnedExpression)) {
							return;
						}

						if (t.isArrowFunctionExpression(initializer)) {
							initializer.body = t.booleanLiteral(true);
							return;
						}

						initializer.body = t.blockStatement([t.returnStatement(t.booleanLiteral(true))]);
					},
				},
			}),
		],
	});

	return result?.code ?? source;
}

class SupabaseIsBrowserOverridePlugin {
	apply(compiler) {
		compiler.hooks.thisCompilation.tap('SupabaseIsBrowserOverridePlugin', (compilation) => {
			compilation.hooks.processAssets.tap(
				{
					name: 'SupabaseIsBrowserOverridePlugin',
					stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY,
				},
				(assets) => {
					Object.keys(assets)
						.filter((assetName) => /\.(?:mjs|cjs|js)$/.test(assetName))
						.forEach((assetName) => {
							const asset = compilation.getAsset(assetName);
							const source = asset.source.source().toString();
							const next = transformIsBrowser(source);

							if (next !== source) {
								compilation.updateAsset(assetName, new sources.RawSource(next));
							}
						});
				},
			);
		});
	}
}

module.exports = (webpack) => {
	webpack.chainWebpack((config) => {
		config.resolve.alias.set('@supabase/storage-js', resolve(__dirname, 'supabase-storage'));
		config.resolve.alias.set('@supabase/storage-js$', resolve(__dirname, 'supabase-storage'));
		config.plugin('supabase-is-browser-override').use(SupabaseIsBrowserOverridePlugin);
	});
};
