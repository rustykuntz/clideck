module.exports = {
  appId: 'dev.clideck.desktop', productName: 'CliDeck',
  directories: { output: 'dist', buildResources: 'assets' },
  files: ['main.cjs', 'preload.cjs', 'lib/**', 'renderer/**', 'assets/**', 'package.json'],
  extraResources: [{ from: '.staging/runtime', to: 'runtime' }],
  asar: true, npmRebuild: false,
  mac: {
    category: 'public.app-category.developer-tools', target: ['dmg', 'zip'],
    icon: 'assets/icon.icns', hardenedRuntime: true,
    extendInfo: { NSMicrophoneUsageDescription: 'CliDeck uses your microphone for voice and dictation plugins.' },
  },
  win: { target: ['nsis'], icon: 'assets/icon.ico' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { target: ['AppImage', 'deb'], category: 'Development', icon: 'assets/icon.png' },
};
