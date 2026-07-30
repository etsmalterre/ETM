# Worktree Status Skill

## When to use

Invoke with `/worktree-status` to see every active feature worktree at a glance — across
**both** projects (ETM and TRM): which slot it's on (TRM slots show as `trm:N`),
its project, whether its servers are alive, whether the web port is actually serving, how
far the branch is ahead/behind `origin/master`, and which slots are free per project
(NG and TRM have disjoint port ranges — `300N`/`808N` vs `517N`). Run it anywhere (it reads
the shared registry at `~/.claude/mps-worktrees.json`).

## Steps

1. **Run the status script:**
   ```bash
   node scripts/worktree/status.mjs
   ```
   (Run an optional `git -C C:/dev/etsmalterre/ETM fetch origin -q` first if you want the
   ahead/behind counts to reflect the very latest `master`.)

2. **Relay the output** to the user: the per-slot health (UP / DEGRADED / PARTIAL / DOWN),
   URLs, branch divergence, and the list of free slots.

   `status.mjs` probes `/api/health?db=1` per slot, so `UP` means *usable*, not just
   "port open". The `HFSQL` line is the one to read.

3. **If a slot is DEGRADED** — the API is listening but HFSQL is unreachable — that IS
   the diagnosis for "the app loads forever / every screen spins". Say so and offer the
   printed remedy (`up.mjs <feature> --restart` for its own API; start the owning ETM
   worktree when a TRM slot's borrowed API is down). Do **not** go looking at feature
   code first: `/api/health` still answers 200 and nothing in the UI says "database".
   Usual trigger is a burst of `apps/api/src` edits restarting `tsx watch` — see
   `claude_doc/worktrees.md` § "The browser loads forever".

4. **If it flags stale entries** (servers dead or the worktree missing on disk), check
   whether the worktree still exists on disk before offering to clean it:
   - **Tree still there** (servers just died — a reboot, a crash) → the work in it is
     intact, so offer to **restart it in place** rather than remove it:
     ```bash
     node scripts/worktree/up.mjs <feature> [ng|trm] --restart
     ```
   - **Tree gone / work already landed** → clean the entry. For each stale slot the
     user confirms:
     ```bash
     cd /c/dev/ETM && node scripts/worktree/down.mjs <slot> --remove
     ```
     (omit `--remove` to just free the slot while keeping the worktree on disk).
