This is my website!  https://reemmyboi.github.io/personalwebsite-/#

## Blog admin (private)

`admin.html` is a private page for creating/editing/deleting blog posts
without touching code. It's not linked from the site's nav — you get to it
by typing the URL directly (e.g. `https://reemmyboi.github.io/personalwebsite-/admin.html`).
It's gated by a GitHub access token: without a valid one, it can't do
anything (every request to GitHub gets rejected).

### One-time setup: create a token

1. GitHub → click your profile picture → **Settings** → **Developer settings**
   (bottom of the left sidebar) → **Personal access tokens** → **Fine-grained tokens**.
2. **Generate new token**.
3. Name it something like `personalwebsite-admin`.
4. **Expiration**: set an actual date (90 days is reasonable). Never pick
   "No expiration." When it expires, just generate a new one and paste it in
   again — takes 30 seconds.
5. **Repository access** → "Only select repositories" → choose
   `reemmyboi/personalwebsite-`. Do **not** choose "All repositories."
6. **Permissions** → **Repository permissions** → find **Contents** → set to
   **Read and write**. Leave every other permission on "No access" — this
   token should be able to do exactly one thing.
7. **Generate token**, then copy it immediately (GitHub only shows it once).
8. Open `admin.html`, paste the token in, click **Unlock**.

The token is saved in that browser only (not synced anywhere) so you won't
need to paste it in again on that device until it expires or you click
**Log out**.

### What this token can and can't do

- It can only touch this one repository, and only read/write file contents.
  It can't see your other repos, change settings, manage collaborators, or
  do anything with billing/account access.
- `admin.html` itself is a public file like any other on the site — anyone
  who finds the URL can open it, but it's inert without a valid token (every
  action just gets rejected by GitHub).
- If a token were ever leaked, worst case is someone edits/deletes a blog
  post or uploads junk to `photos/`. Since it's all normal git history, an
  unwanted change is always fixable with `git revert` from a local clone,
  same as any other commit to this repo.
- Never paste your token into `admin.html` on a public or shared computer
  without clicking **Log out** before you walk away.
