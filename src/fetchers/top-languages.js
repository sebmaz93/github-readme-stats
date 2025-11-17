// @ts-check

import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { CustomError, MissingParamError } from "../common/error.js";
import { wrapTextMultiline } from "../common/fmt.js";
import { request } from "../common/http.js";

/**
 * Top languages fetcher object.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Languages fetcher response.
 */
const fetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!, $reposAfter: String) {
        user(login: $login) {
          # fetch only owner repos & not forks
          repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $reposAfter) {
            pageInfo {
            hasNextPage
            endCursor
            }
            nodes {
              name
              languages(first: 20, orderBy: {field: SIZE, direction: DESC}) {
                edges {
                  size
                  node {
                    color
                    name
                  }
                }
              }
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * @typedef {import("./types").TopLangData} TopLangData Top languages data.
 */

/**
 * Fetch top languages for a given username.
 *
 * @param {string} username GitHub username.
 * @param {string[]} exclude_repo List of repositories to exclude.
 * @param {number} size_weight Weightage to be given to size.
 * @param {number} count_weight Weightage to be given to count.
 * @returns {Promise<TopLangData>} Top languages data.
 */
const fetchTopLanguages = async (
  username,
  exclude_repo = [],
  size_weight = 1,
  count_weight = 0,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  /** @type {Array} */
  let allRepoNodes = [];
  let cursor = null;

  while (true) {
    const res = await retryer(fetcher, { login: username, reposAfter: cursor });

    if (res.data.errors) {
      logger.error(res.data.errors);
      const [firstError] = res.data.errors;
      if (firstError.type === "NOT_FOUND") {
        throw new CustomError(
          firstError.message || "Could not fetch user.",
          CustomError.USER_NOT_FOUND,
        );
      }
      if (firstError.message) {
        throw new CustomError(
          wrapTextMultiline(firstError.message, 90, 1)[0],
          res.statusText,
        );
      }
      throw new CustomError(
        "Something went wrong while trying to retrieve the language data using the GraphQL API.",
        CustomError.GRAPHQL_ERROR,
      );
    }

    const repositories = res.data.data.user.repositories;
    allRepoNodes = allRepoNodes.concat(repositories.nodes);

    if (!repositories.pageInfo.hasNextPage) {
      break;
    }
    cursor = repositories.pageInfo.endCursor;
  }

  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];
  const repoToHide = Object.fromEntries(
    allExcludedRepos.map((name) => [name, true]),
  );

  allRepoNodes = allRepoNodes
    .sort((a, b) => b.size - a.size)
    .filter((repo) => !repoToHide[repo.name]);

  let repoCount = 0;

  const languageStats = allRepoNodes
    .filter((node) => node.languages.edges.length > 0)
    .reduce((acc, curr) => curr.languages.edges.concat(acc), [])
    .reduce((acc, edge) => {
      const langName = edge.node.name;
      const prev = acc[langName];

      if (prev) {
        repoCount = prev.count + 1;
        acc[langName] = {
          name: langName,
          color: edge.node.color,
          size: prev.size + edge.size,
          count: repoCount,
        };
      } else {
        repoCount = 1;
        acc[langName] = {
          name: langName,
          color: edge.node.color,
          size: edge.size,
          count: repoCount,
        };
      }
      return acc;
    }, {});

  Object.keys(languageStats).forEach((name) => {
    const lang = languageStats[name];
    lang.size =
      Math.pow(lang.size, size_weight) * Math.pow(lang.count, count_weight);
  });

  const topLangs = Object.keys(languageStats)
    .sort((a, b) => languageStats[b].size - languageStats[a].size)
    .reduce((result, key) => {
      result[key] = languageStats[key];
      return result;
    }, {});

  return topLangs;
};

export { fetchTopLanguages };
export default fetchTopLanguages;
