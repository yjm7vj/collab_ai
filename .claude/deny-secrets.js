/**
 * PreToolUse guard: refuses any Bash command that touches `.dev.vars`.
 *
 * The `permissions.deny` rules in settings.json stop the Read and Edit tools,
 * but Bash is an open-ended surface — cat, sed, awk, grep, node, a here-doc,
 * anything. Rather than enumerate readers, this matches the filename itself.
 *
 * Fails CLOSED: if the hook payload can't be parsed, the raw stdin is scanned
 * anyway, so a malformed frame can't be used to slip a read through.
 */
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(s).tool_input?.command ?? "";
  } catch {
    cmd = s;
  }
  if (/\.dev\.vars/.test(cmd)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Blocked: .dev.vars holds secrets and is off-limits to the agent. " +
            "Edit it yourself, or temporarily remove the guard in .claude/settings.json.",
        },
      }),
    );
  }
});
