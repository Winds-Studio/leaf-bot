import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";
import { Octokit } from "octokit";
import type { Context } from "koishi";
import { Schema } from "koishi";
import { type GitHubPushEvent } from "koishi-plugin-adapter-github";

export const name = "notice";

export interface Config {
  groups: string[];
  botSid: string;
}

export const Config: Schema<Config> = Schema.object({
  groups: Schema.array(Schema.string().required())
    .default([])
    .description("接收更新通知的群频道 ID 列表。"),
  botSid: Schema.string().required().description("用于发送通知的 Bot SID。"),
});

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

const octokit = new Octokit();

async function formatLeafBuildMessage() {
  const owner = "Winds-Studio";
  const repo = "Leaf";
  const { data: releaseData } = await octokit.rest.repos.getLatestRelease({
    owner,
    repo,
  });

  const jarAsset = releaseData.assets?.find((asset) =>
    /^leaf-.+-\d+\.jar$/i.test(asset.name),
  );

  const tagVersion = (releaseData.tag_name || "").replace(/^ver\//, "");
  const parsed = jarAsset?.name.match(/^leaf-(.+)-(\d+)\.jar$/i);
  const version = parsed?.[1] || tagVersion || "未知";
  const build = parsed?.[2] || "未知";
  const publishTime = releaseData.published_at || releaseData.created_at;
  const datetime = publishTime
    ? dayjs(publishTime).format("YYYY-MM-DD HH:mm")
    : "未知";
  const relative = publishTime ? dayjs(publishTime).fromNow() : "未知";

  const commitRef = releaseData.target_commitish;
  let summary = "未知";
  if (commitRef) {
    const { data: commitData } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: commitRef,
    });
    const shortSha = (commitData.sha || "").slice(0, 7) || "unknown";
    const title = commitData.commit?.message?.split("\n")[0] || "无提交信息";
    summary = `${shortSha} ${title}`;
  }

  const downloadUrl = jarAsset?.browser_download_url || "无";

  return [
    "🌿 Leaf 构建推送",
    "",
    `版本：${version}`,
    `构建：#${build}`,
    `时间：${datetime} · ${relative}`,
    "",
    "「提交摘要」",
    summary,
    "",
    "「下载」",
    downloadUrl,
  ].join("\n");
}

function formatPushMessage(event: GitHubPushEvent) {
  const push = event;

  const author: string = push.actor?.login || push.actor?.name || "unknown";
  const datetime = dayjs(push.timestamp).format("YYYY-MM-DD HH:mm");
  const branch = push.ref?.replace(/^refs\/heads\//, "") || "";
  const version = branch.slice(4);
  const commitMessage = push.headCommit?.message?.split("\n")[0] || "无";
  const commitUrl: string = push.headCommit?.url || "无";

  return [
    "🌿 Leaf 更新推送",
    "",
    `提交者：${author}`,
    `时间：${datetime}`,
    `版本：${version}`,
    "",
    "「摘要」",
    commitMessage,
    "",
    "「链接」",
    commitUrl,
  ].join("\n");
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name);

  ctx.command("leaf", "查询 Leaf 最新构建信息").action(async () => {
    try {
      return await formatLeafBuildMessage();
    } catch (error) {
      logger.warn(error);
      return "查询 Leaf 构建信息失败，请稍后重试。";
    }
  });

  ctx.on("github/push", async (event: GitHubPushEvent) => {
    if (event.repo !== "Leaf" || !config.groups.length) return;

    const branch = event.ref?.replace(/^refs\/heads\//, "") || "";
    if (!branch.startsWith("ver/")) return;

    const bot = ctx.bots[config.botSid];

    if (!bot) {
      logger.warn("未找到可用 Bot，无法发送 Leaf 更新通知。");
      return;
    }

    await bot.broadcast(config.groups, formatPushMessage(event));
  });
}
