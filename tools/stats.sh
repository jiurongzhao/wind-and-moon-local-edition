#!/data/data/com.termux/files/usr/bin/bash
# stats.sh —— 一眼看两个站的热度与下载量。
#
#   ./tools/stats.sh
#
# GitHub 有官方计数（附件下载数 + 近 14 天浏览量/clone，后者只有仓库主人看得到）；
# Gitee 官方**不提供附件下载次数**，API 和网页都没有这个字段，只能看 star/fork。
set -euo pipefail

GH_REPO="jiurongzhao/wind-and-moon-local-edition"
GITEE_REPO="zhao-jiurong/wind-and-moon-local-edition"

echo "════════════ GitHub ════════════"
gh api "repos/$GH_REPO" --jq '"star \(.stargazers_count) ｜ fork \(.forks_count) ｜ watch \(.subscribers_count) ｜ 最近推送 \(.pushed_at)"'

echo "── 发行版附件下载量 ──"
gh api "repos/$GH_REPO/releases" --jq '.[] | "\(.tag_name)  " + ([.assets[] | "\(.name)=\(.download_count)"] | join("  "))'

echo "── 近 14 天流量（仅仓库主人可见）──"
gh api "repos/$GH_REPO/traffic/views" --jq '"浏览 \(.count) 次 ｜ 独立访客 \(.uniques)"'
gh api "repos/$GH_REPO/traffic/clones" --jq '"clone \(.count) 次 ｜ 独立来源 \(.uniques)"'

echo
echo "════════════ Gitee ════════════"
TOKEN=""
if [ -f "$HOME/.gitee_token" ]; then TOKEN="$(tr -d ' \t\r\n' < "$HOME/.gitee_token")"; fi
curl -sS --max-time 30 "https://gitee.com/api/v5/repos/$GITEE_REPO?access_token=$TOKEN" \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print("star %s ｜ fork %s ｜ watch %s" % (d.get("stargazers_count"), d.get("forks_count"), d.get("watchers_count")))'
echo "（附件下载次数：Gitee 官方不提供，看不到）"
