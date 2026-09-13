export const ACTOR_FRAGMENT = `fragment Actor on Actor {
  __typename
  login
  ... on User { id databaseId }
  ... on Bot { id databaseId }
  ... on EnterpriseUserAccount { id }
  ... on Mannequin { id databaseId }
  ... on Organization { id databaseId }
}`;

export const PAGE_FRAGMENT = `fragment Page on PageInfo {
  hasNextPage
  endCursor
}`;

/** GitHub errors with useAndDefineFragment if a fragment is defined but unused. */
function withUsedFragments(query: string): string {
  const parts: string[] = [];
  if (/\.\.\.Actor\b/.test(query)) parts.push(ACTOR_FRAGMENT);
  if (/\.\.\.Page\b/.test(query)) parts.push(PAGE_FRAGMENT);
  return `${parts.join("\n\n")}${parts.length ? "\n" : ""}${query}`;
}

export const Q1_VIEWER_PROFILE = withUsedFragments(`
query ViewerProfile {
  viewer {
    id
    databaseId
    login
    name
    email
    createdAt
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q2_VIEWER_PULL_REQUESTS = withUsedFragments(`
query ViewerPullRequests($after: String) {
  viewer {
    pullRequests(
      first: 100
      after: $after
      states: [OPEN, CLOSED, MERGED]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo { ...Page }
      nodes {
        id
        number
        url
        title
        state
        isDraft
        merged
        mergedAt
        closedAt
        createdAt
        updatedAt
        additions
        deletions
        changedFiles
        baseRefName
        headRefName
        repository { id nameWithOwner isPrivate isFork }
        author { ...Actor }
        mergedBy { ...Actor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q3_VIEWER_ISSUE_COMMENTS = withUsedFragments(`
query ViewerIssueComments($after: String) {
  viewer {
    issueComments(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { ...Page }
      nodes {
        id
        createdAt
        updatedAt
        body
        author { ...Actor }
        url
        issue {
          id
          number
          title
          url
          repository { id nameWithOwner owner { login } name isPrivate }
        }
        pullRequest {
          id
          number
          url
          author { ...Actor }
          repository { id nameWithOwner isPrivate }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q4_REVIEW_CONTRIB_SLICE = withUsedFragments(`
query ReviewContribSlice($from: DateTime!, $to: DateTime!, $reviewAfter: String) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      startedAt
      endedAt
      restrictedContributionsCount
      pullRequestReviewContributions(
        first: 100
        after: $reviewAfter
        orderBy: { direction: DESC }
      ) {
        pageInfo { ...Page }
        nodes {
          occurredAt
          isRestricted
          pullRequest { id number url author { ...Actor } }
          pullRequestReview { id state submittedAt }
          repository { id nameWithOwner }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q5_VIEWER_ISSUES = withUsedFragments(`
query ViewerIssues($after: String, $login: String!) {
  viewer {
    issues(
      first: 100
      after: $after
      states: [OPEN, CLOSED]
      filterBy: { createdBy: $login }
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo { ...Page }
      nodes {
        __typename
        id
        number
        url
        title
        state
        createdAt
        closedAt
        updatedAt
        repository { id nameWithOwner isPrivate }
        author { ...Actor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q6_PR_CORE_BATCH = withUsedFragments(`
query PrCoreBatch($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      number
      url
      title
      state
      isDraft
      merged
      mergedAt
      closedAt
      createdAt
      updatedAt
      additions
      deletions
      changedFiles
      baseRefName
      headRefName
      body
      reviewDecision
      mergeCommit { oid }
      statusCheckRollup { state }
      labels(first: 20) {
        pageInfo { hasNextPage }
        nodes { name }
      }
      repository { id nameWithOwner isPrivate isFork }
      author { ...Actor }
      mergedBy { ...Actor }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q7_PR_FILES_BATCH = withUsedFragments(`
query PrFilesBatch($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      changedFiles
      files(first: 50) {
        totalCount
        pageInfo { ...Page }
        nodes { path additions deletions changeType }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q7_PR_FILES = withUsedFragments(`
query PrFiles($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      changedFiles
      files(first: 50, after: $after) {
        totalCount
        pageInfo { ...Page }
        nodes { path additions deletions changeType }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q9_PR_COMMENTS_BATCH = withUsedFragments(`
query PrCommentsBatch($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      comments(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage }
        nodes {
          id
          createdAt
          updatedAt
          body
          author { ...Actor }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q12_ISSUE_OR_PR = withUsedFragments(`
query IssueOrPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      url
      title
      state
      merged
      mergedAt
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q13_REVIEWS_BY_AUTHOR = withUsedFragments(`
query ReviewsByAuthor($id: ID!, $login: String!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      id
      number
      url
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
      reviews(
        first: 50
        after: $after
        author: $login
        states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]
      ) {
        pageInfo { ...Page }
        nodes {
          id
          state
          submittedAt
          body
          author { ...Actor }
          commit { oid }
          comments(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              id
              createdAt
              path
              originalCommit { oid }
              body
              author { ...Actor }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);

export const Q13_REVIEW_COMMENTS = withUsedFragments(`
query ReviewComments($reviewId: ID!, $after: String) {
  node(id: $reviewId) {
    ... on PullRequestReview {
      comments(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id
          createdAt
          path
          originalCommit { oid }
          body
          author { ...Actor }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`);
