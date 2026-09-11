# Git Changes

Open **Git changes** from a session's terminal actions menu to see what changed
in its repository. The panel refreshes while it is visible.

**Uncommitted** includes staged, unstaged, and new files. **Since base** also
includes commits since the branch split from its base. Choose a worktree when
an agent is working in another checkout. You can set a base branch in the plugin
settings; otherwise CliDeck looks for the repository's default branch.

The panel only reads Git state. It never stages files or changes the index.
Large patches and unusual files can be left out of the preview; a notice tells
you when that happens. Symlinks display their target path, without opening it.
