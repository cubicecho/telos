const path = require('node:path');
const Module = require('node:module');

// npm workspaces hoists most packages to the repo root, but Metro resolves from
// the project directory. Teach Node and Metro about both.
const localModules = path.resolve(__dirname, 'node_modules');
if (!process.env.NODE_PATH?.split(path.delimiter).includes(localModules)) {
  process.env.NODE_PATH = [localModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
}

const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

const workspaceRoot = path.resolve(__dirname, '..');
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [localModules, path.resolve(workspaceRoot, 'node_modules')];

module.exports = withNativeWind(config, { input: './global.css' });
