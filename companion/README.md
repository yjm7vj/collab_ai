# HuddleAI local companion

The companion runs a real terminal on the developer's computer. It listens only
on `127.0.0.1`, accepts approved HuddleAI origins, and limits the terminal's
starting directory to the folder selected at launch.

```powershell
cd companion
npm install
npm start -- --cwd C:\path\to\project
```

Copy the one-time pairing code into the Terminal panel in HuddleAI. For another
development origin, add `--origin http://localhost:4173`. Stop the companion to
revoke the pairing code and close every terminal.

Selecting a project folder is not a filesystem sandbox. Commands approved in a
terminal can still refer to files outside that folder, just as commands in a
normal shell can. HuddleAI therefore keeps agent commands behind room approval
unless they match its narrow read-only command classifier.
