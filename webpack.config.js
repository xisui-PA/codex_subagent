const path = require('path');

/**
 * @param {{ mode?: 'development' | 'production' }} argv
 * @returns {import('webpack').Configuration}
 */
module.exports = (env, argv) => {
  const mode = argv.mode === 'development' ? 'development' : 'production';

  return {
    mode,
    target: 'node',
    entry: {
      extension: './src/extension.ts',
    },
    devtool: 'source-map',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      // Emit relative source paths so VS Code can map breakpoints back to src/.
      devtoolNamespace: '',
      // Remove stale files from previous builds.
      clean: true,
      library: {
        type: 'commonjs2',
      },
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.json',
            },
          },
        },
      ],
    },
    // The VS Code API is provided by the host and must not be bundled.
    externals: {
      vscode: 'commonjs vscode',
    },
    optimization: {
      // Keep the extension bundle readable and fast to build.
      minimize: false,
    },
    stats: 'errors-warnings',
  };
};
