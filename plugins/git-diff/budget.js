// What the panel is willing to parse and render, and the one thing a change count cannot catch.
//
// Counting changed lines misses a minified bundle or a one-line JSON blob: two changed lines of
// several hundred kilobytes each sit far under any change-count limit. Parsing them is cheap
// (measured at about a millisecond for a line of 850,000 characters), so the cost is not here on
// the server: diff2html turns such a line into roughly twice its length in HTML, that HTML is
// sent to every open tab on every poll, and the browser then lays out and highlights one
// enormous line. A 1,000,000 character line produces about 2 MB of HTML per refresh.
//
// So a file whose longest line is over the ceiling is replaced, before parsing, by the
// placeholder git itself uses for binary content. The file still appears in the diff with its
// name; only its contents are left out. The patch handed to Copy patch is always the real one.
//
// No npm dependencies, so the tests can drive this in a checkout where the plugin has not been
// installed.

const MAX_PATCH_BYTES = 8 * 1024 * 1024;   // above this the patch is never parsed at all
const MAX_LINE_CHARS = 20000;              // per line, across every file in the patch

// Only the plain header form is treated as a file boundary. The plugin's diff always names a
// base commit, and git then reports even a conflicted file with an ordinary "diff --git" header,
// so the combined-diff forms ("diff --cc") never appear in what is parsed here.
const FILE_START = 'diff --git ';

// Both sides of a git header carry the same path unless the file was renamed, so the identical
// case is matched first and copes with spaces in names. The second pattern is ambiguous for a
// renamed path containing a space, which only affects the name in the note.
function pathFromHeader(line) {
  const rest = line.slice(FILE_START.length);
  const same = rest.match(/^a\/(.+) b\/\1$/);
  if (same) return same[1];
  const pair = rest.match(/^a\/(.+) b\/(.+)$/);
  return pair ? pair[2] : '';
}

// git's own wording for a file it will not show, which diff2html renders as "Binary file".
// Without a usable path the binary-patch marker does the same job without naming anything.
function placeholderFor(path) {
  return path ? `Binary files a/${path} and b/${path} differ` : 'GIT binary patch';
}

// Returns the patch to parse, plus path → longest line length for every file left out. Files
// under the ceiling come back byte for byte as they arrived.
function capLongLines(patch, limit = MAX_LINE_CHARS) {
  if (!patch) return { patch: '', longLines: new Map() };

  const longLines = new Map();
  const lines = patch.split('\n');
  const out = [];

  let header = [];      // the current file's header, up to where its content starts
  let body = [];        // its content
  let inBody = false;
  let longest = 0;
  let path = '';
  let open = false;

  const flush = () => {
    if (!open) return;
    if (longest > limit) {
      out.push(...header, placeholderFor(path));
      if (path) longLines.set(path, longest);
    } else {
      out.push(...header, ...body);
    }
    header = [];
    body = [];
    inBody = false;
    longest = 0;
    path = '';
  };

  for (const line of lines) {
    if (line.startsWith(FILE_START)) {
      flush();
      open = true;
      path = pathFromHeader(line);
      header = [line];
      continue;
    }
    if (!open) {          // anything before the first file header travels through untouched
      out.push(line);
      continue;
    }
    if (line.length > longest) longest = line.length;
    // git writes the ---/+++ pair and then the hunks. A binary placeholder replaces all of it,
    // so everything from there on counts as content.
    if (!inBody && (line.startsWith('--- ') || line.startsWith('@@'))) inBody = true;
    if (inBody) body.push(line);
    else header.push(line);
  }
  flush();

  // Dropping a file's content can drop the patch's final newline with it, and a patch that does
  // not end in one is not a patch.
  let text = out.join('\n');
  if (patch.endsWith('\n') && !text.endsWith('\n')) text += '\n';
  return { patch: text, longLines };
}

module.exports = { MAX_PATCH_BYTES, MAX_LINE_CHARS, capLongLines, pathFromHeader };
