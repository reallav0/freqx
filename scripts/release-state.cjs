'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const query = 'query($owner: String!, $name: String!, $tag: String!) { repository(owner: $owner, name: $name) { release(tagName: $tag) { isDraft } } }';
const runGh = args => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });

function getReleaseState(repository, tag, run = runGh) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^v\d+\.\d+\.\d+$/.test(tag || '')) {
    throw new Error('Release lookup requires GITHUB_REPOSITORY and a version RELEASE_TAG.');
  }
  const [owner, name] = repository.split('/');
  // GraphQL returns a successful null for a missing release. CLI/auth/network failures still throw.
  const response = JSON.parse(run(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `tag=${tag}`]));
  if (response.errors?.length || !response.data?.repository) throw new Error('GitHub release lookup failed or the repository is inaccessible.');
  const release = response.data.repository.release;
  if (release === null) return { exists: false, published: false };
  if (typeof release?.isDraft !== 'boolean') throw new Error('GitHub returned an invalid release response.');
  return { exists: true, published: !release.isDraft };
}

function prepareRelease(repository, tag, run = runGh) {
  const state = getReleaseState(repository, tag, run);
  if (state.published) throw new Error('Release is already published; refusing to replace its artifacts.');
  if (!state.exists) run(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--generate-notes', '--title', `FreqX ${tag}`]);
}

if (require.main === module) {
  try {
    const { GITHUB_REPOSITORY: repository, RELEASE_TAG: tag, GITHUB_OUTPUT: output } = process.env;
    if (process.argv[2] === '--prepare') prepareRelease(repository, tag);
    else {
      if (!output) throw new Error('Missing workflow output path.');
      const state = getReleaseState(repository, tag);
      fs.appendFileSync(output, `published=${state.published}\n`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { getReleaseState, prepareRelease };
