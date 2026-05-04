import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import type { Context, Session } from "koishi";
import { Schema } from "koishi";

export const name = "approve";

export interface Config {}

export const Config: Schema<Config> = Schema.object({});

const repoOwner = "Winds-Studio";
const repoName = "Leaf";
const octokit = new Octokit();
const cacheTtlMs = 60_000;

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
  etag?: string;
  lastModified?: string;
};

const createCachedFetcher = <T>(
  fetcher: (
    headers: Record<string, string>,
  ) => Promise<{ value: T; etag?: string; lastModified?: string }>,
) => {
  let cache: CacheEntry<T> | null = null;
  let inflight: Promise<CacheEntry<T>> | null = null;

  return async () => {
    if (cache && Date.now() < cache.expiresAt) {
      return cache;
    }

    if (inflight) {
      return inflight;
    }

    inflight = (async () => {
      const headers: Record<string, string> = {};
      if (cache?.etag) {
        headers["If-None-Match"] = cache.etag;
      }
      if (cache?.lastModified) {
        headers["If-Modified-Since"] = cache.lastModified;
      }

      try {
        const result = await fetcher(headers);
        cache = {
          expiresAt: Date.now() + cacheTtlMs,
          value: result.value,
          etag: result.etag,
          lastModified: result.lastModified,
        };
        return cache;
      } catch (error: unknown) {
        if (error instanceof RequestError && error.status === 304 && cache) {
          cache = {
            ...cache,
            expiresAt: Date.now() + cacheTtlMs,
          };
          return cache;
        }
        throw error;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  };
};

const getDefaultBranch = createCachedFetcher(async (headers) => {
  const repoInfo = await octokit.rest.repos.get({
    owner: repoOwner,
    repo: repoName,
    headers,
  });

  return {
    value: repoInfo.data.default_branch,
    etag: repoInfo.headers.etag,
    lastModified: repoInfo.headers["last-modified"],
  };
});

type CommitInfo = {
  latestSha: string;
  shortSha: string;
  defaultBranch: string;
};

const getLatestCommit = createCachedFetcher(async (headers) => {
  const { value: defaultBranch } = await getDefaultBranch();
  const commitInfo = await octokit.rest.repos.getCommit({
    owner: repoOwner,
    repo: repoName,
    ref: defaultBranch,
    headers,
  });
  const latestSha = commitInfo.data.sha;

  return {
    value: {
      latestSha,
      shortSha: latestSha.substring(0, 7),
      defaultBranch,
    } satisfies CommitInfo,
    etag: commitInfo.headers.etag,
    lastModified: commitInfo.headers["last-modified"],
  };
});

const handleEvent = async (ctx: Context, session: Session) => {
  if (!session.messageId) {
    return;
  }

  const logger = ctx.logger;

  try {
    const { value } = await getLatestCommit();
    const { latestSha, shortSha } = value;

    const applyMessage = (session.content || "").trim();

    if (applyMessage.includes(latestSha) || applyMessage.includes(shortSha)) {
      await session.bot.handleGuildMemberRequest(session.messageId, true);
      logger.info(`已通过 ${session.userId} 的加群请求，SHA: ${applyMessage}`);
    } else {
      await session.bot.handleGuildMemberRequest(session.messageId, false);
      logger.info(
        `已拒绝 ${session.userId} 的加群请求。错误 SHA: ${applyMessage}，期望: ${shortSha} 或 ${latestSha}`,
      );
    }
  } catch (error) {
    logger.warn(`获取 GitHub 最新 commit 失败: ${error}`);
  }
};

export function apply(ctx: Context, _config: Config) {
  ctx.on("guild-member-request", async (session) => {
    await handleEvent(ctx, session);
  });
}
