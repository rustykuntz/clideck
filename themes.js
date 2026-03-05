// Built-in terminal theme presets.
// Each theme is a valid xterm.js ITheme object.
// Users can add custom themes via custom-themes.json in the project root.

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const BUILT_IN = [
  {
    id: 'default',
    name: 'Midnight',
    accent: '#3b82f6',
    theme: {
      background: '#020617',
      foreground: '#e2e8f0',
      cursor: '#e2e8f0',
      selectionBackground: '#334155',
      black: '#1e293b', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
      blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e2e8f0',
      brightBlack: '#475569', brightRed: '#f87171', brightGreen: '#4ade80', brightYellow: '#facc15',
      brightBlue: '#60a5fa', brightMagenta: '#c084fc', brightCyan: '#22d3ee', brightWhite: '#f8fafc',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    accent: '#bd93f9',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    accent: '#81a1c1',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    accent: '#89b4fa',
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    accent: '#268bd2',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#839496',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    accent: '#61afef',
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
      brightBlack: '#4f5666', brightRed: '#be5046', brightGreen: '#98c379', brightYellow: '#d19a66',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#e6e6e6',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    accent: '#66d9ef',
    theme: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
      brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    accent: '#7aa2f7',
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    accent: '#58a6ff',
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#c9d1d9',
      selectionBackground: '#264f78',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    accent: '#d79921',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selectionBackground: '#3c3836',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  // ── Light themes ──
  {
    id: 'github-light',
    name: 'GitHub Light',
    accent: '#0969da',
    theme: {
      background: '#f6f8fa',
      foreground: '#24292f',
      cursor: '#044289',
      selectionBackground: '#b6d4fe',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700',
      blue: '#0550ae', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#7d4e00',
      brightBlue: '#0969da', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    accent: '#268bd2',
    theme: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900',
      brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#839496',
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    accent: '#1e66f5',
    theme: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      selectionBackground: '#ccd0da',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
      blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#7c7f93',
      brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d',
      brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#8c8fa1',
    },
  },
  {
    id: 'one-light',
    name: 'One Light',
    accent: '#4078f2',
    theme: {
      background: '#fafafa',
      foreground: '#383a42',
      cursor: '#526eff',
      selectionBackground: '#d4d8e0',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
      blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#696c77',
      brightBlack: '#696c77', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401',
      brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#a0a1a7',
    },
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    accent: '#907aa9',
    theme: {
      background: '#faf4ed',
      foreground: '#575279',
      cursor: '#575279',
      selectionBackground: '#dfdad9',
      black: '#575279', red: '#b4637a', green: '#286983', yellow: '#ea9d34',
      blue: '#56949f', magenta: '#907aa9', cyan: '#d7827e', white: '#797593',
      brightBlack: '#797593', brightRed: '#b4637a', brightGreen: '#286983', brightYellow: '#ea9d34',
      brightBlue: '#56949f', brightMagenta: '#907aa9', brightCyan: '#d7827e', brightWhite: '#9893a5',
    },
  },
];

// Load user custom themes from custom-themes.json
function loadCustom() {
  const p = join(__dirname, 'custom-themes.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

const THEMES = [...BUILT_IN, ...loadCustom()];

module.exports = THEMES;
