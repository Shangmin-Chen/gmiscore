export const FRAGMENTS = `
fragment Actor on Actor {
  __typename
  login
  ... on User { id databaseId }
  ... on Bot { id databaseId }
  ... on EnterpriseUserAccount { id }
  ... on Mannequin { id databaseId }
  ... on Organization { id databaseId }
}

fragment GitActor on GitActor {
  name
  email
  date
  user { id databaseId login }
}

fragment Page on PageInfo {
  hasNextPage
  endCursor
}
`;

export const Q1_VIEWER_PROFILE = `
${FRAGMENTS}
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
}`;

export const Q2_VIEWER_PULL_REQUESTS = `
${FRAGMENTS}
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
}`;

export const Q3_VIEWER_ISSUE_COMMENTS = `
${FRAGMENTS}
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
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q4_CONTRIBUTION_YEARS = `
query ContributionYears {
  viewer {
    contributionsCollection {
      contributionYears
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q4_CONTRIB_YEAR = `
${FRAGMENTS}
query ContribYear($from: DateTime!, $to: DateTime!, $reviewAfter: String) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      startedAt
      endedAt
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      commitContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner owner { login } name isPrivate }
        contributions(first: 1) {
          totalCount
        }
      }
      pullRequestReviewContributions(first: 100, after: $reviewAfter) {
        pageInfo { ...Page }
        nodes {
          occurredAt
          pullRequest { id number url }
          pullRequestReview { id state submittedAt }
          repository { id nameWithOwner }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q5_VIEWER_ISSUES = `
${FRAGMENTS}
query ViewerIssues($after: String) {
  viewer {
    issues(
      first: 100
      after: $after
      states: [OPEN, CLOSED]
      orderBy: { field: UPDATED_AT, direction: DESC }
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
        repository { id nameWithOwner isPrivate }
        author { ...Actor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q6_PR_CORE = `
${FRAGMENTS}
query PrCore($id: ID!) {
  node(id: $id) {
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
      repository { id nameWithOwner isPrivate isFork }
      author { ...Actor }
      mergedBy { ...Actor }
      body
      reviewDecision
      mergeCommit { oid }
      statusCheckRollup { state }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q7_PR_FILES = `
${FRAGMENTS}
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
}`;

export const Q8_PR_COMMITS = `
${FRAGMENTS}
query PrCommits($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      commits(first: 50, after: $after) {
        totalCount
        pageInfo { ...Page }
        nodes {
          commit {
            oid
            messageHeadline
            messageBody
            authoredDate
            committedDate
            author { ...GitActor }
            committer { ...GitActor }
            additions
            deletions
            changedFilesIfAvailable
            parents { oid }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q9_PR_COMMENTS = `
${FRAGMENTS}
query PrComments($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      comments(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id createdAt updatedAt body
          author { ...Actor }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q10_PR_REVIEWS = `
${FRAGMENTS}
query PrReviews($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      reviews(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id state submittedAt body
          author { ...Actor }
          commit { oid }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q11_PR_THREADS = `
${FRAGMENTS}
query PrThreads($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id isResolved isOutdated path line
          comments(first: 50) {
            pageInfo { ...Page }
            nodes {
              id createdAt body
              author { ...Actor }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q11_THREAD_COMMENTS = `
${FRAGMENTS}
query ThreadComments($threadId: ID!, $after: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id createdAt body
          author { ...Actor }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q12_ISSUE_OR_PR = `
${FRAGMENTS}
query IssueOrPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number url title state merged mergedAt
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q13_REVIEWS_BY_AUTHOR = `
${FRAGMENTS}
query ReviewsByAuthor($id: ID!, $login: String!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      id number url
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
      reviews(first: 50, after: $after, author: $login) {
        pageInfo { ...Page }
        nodes {
          id state submittedAt body
          author { ...Actor }
          commit { oid }
          comments(first: 50) {
            pageInfo { ...Page }
            nodes {
              id createdAt path originalCommit { oid } body
              author { ...Actor }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q13_REVIEW_COMMENTS = `
${FRAGMENTS}
query ReviewComments($reviewId: ID!, $after: String) {
  node(id: $reviewId) {
    ... on PullRequestReview {
      comments(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id createdAt path originalCommit { oid } body
          author { ...Actor }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const Q14_REPO_AUTHOR_HISTORY = `
${FRAGMENTS}
query RepoAuthorHistory($owner: String!, $name: String!, $authorId: ID!, $after: String) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 50, after: $after, author: { id: $authorId }) {
            pageInfo { ...Page }
            nodes {
              oid
              messageHeadline
              messageBody
              authoredDate
              committedDate
              author { ...GitActor }
              committer { ...GitActor }
              additions
              deletions
              changedFilesIfAvailable
              associatedPullRequests(first: 5) {
                nodes { id number url }
              }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;
