import type { EnvLookup } from "./pr-host.js";
import { linear } from "./issue-trackers/linear/index.js";

/** One comment on a ticket, as the agent brief shows it. */
export interface IssueComment { author: string; createdAt: string; body: string }

/** A state an issue can be moved to. id is the tracker's own; name is for logs. */
export interface WorkflowStep { id: string; name: string }

/** One ticket in full, for the runner, the agent brief and the prep commands. */
export interface Issue {
  /** The tracker's own key for the issue; only the tracker reads it back. */
  id: string;
  /** Canonical ticket ID matching TICKET_ID, e.g. "ENG-142". */
  identifier: string;
  name: string;
  description: string;
  /** Oldest first. */
  comments: IssueComment[];
  /** Display name of the current state. */
  state: string;
  url: string;
  /** Where to move it when work starts; absent once started, or if the tracker has no started state. */
  startTarget?: WorkflowStep;
  /** Where to move it when its PR is ready; absent once finished, or if the tracker has no review state. */
  reviewTarget?: WorkflowStep;
}

/** A ticket assigned to the authenticated user in the ready state (Linear: Todo). */
export interface TodoIssue {
  identifier: string;
  title: string;
  url: string;
  /** Display name of the ready state. */
  state: string;
  /** 1 most urgent … 4 least urgent; 0 for none. */
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  /** The ID prefix: Linear team key, Jira project key. */
  teamKey: string;
  /** Tracker-side project that routes it to a nightshift project via trackerProjects; null if unset. */
  projectName: string | null;
  description: string;
  commentCreatedAt: string[];
}

/** Light view of a queued ticket, which may have left the Todo list. */
export interface IssueSnapshot {
  identifier: string;
  title: string;
  url: string;
  state: string;
  /** In the state listTodo draws from. */
  ready: boolean;
  assignedToMe: boolean;
  description: string;
  commentCreatedAt: string[];
}

/** One ticket ID prefix the tracker knows, with its name. */
export interface TrackerTeam { key: string; name: string }

/** Every method is async; errors are the tracker's own, passed through unchanged. */
export interface IssueTracker {
  /** Full ticket by canonical ID; null when the tracker has no such ticket. */
  getIssue(identifier: string): Promise<Issue | null>;
  /** Move an issue to its own startTarget or reviewTarget. */
  moveIssue(issue: Issue, to: WorkflowStep): Promise<void>;
  /** Tickets assigned to the authenticated user in the ready state. */
  listTodo(): Promise<TodoIssue[]>;
  /** One entry per requested ID; null for IDs the tracker doesn't know. */
  getSnapshots(identifiers: string[]): Promise<Record<string, IssueSnapshot | null>>;
  /** Every team the user can see, sorted by key. */
  listTeams(): Promise<TrackerTeam[]>;
}

/** Static facts about a tracker, usable before any project env is loaded. */
export interface IssueTrackerDescriptor {
  /** Builds the tracker; reads env lazily, so construction never throws. fetchFn defaults to global fetch at call time. */
  create(lookup: EnvLookup, fetchFn?: typeof fetch): IssueTracker;
  /** Credential env keys; they live in the root .env because the shared queue reads them machine-wide. */
  envKeys: string[];
  /** Tool-name prefixes the implementing agent is denied (the tracker's MCP connector). */
  agentDeniedTools: string[];
}

/** Every supported tracker. Adding a tracker = one entry here. */
export const ISSUE_TRACKERS = { linear } satisfies Record<string, IssueTrackerDescriptor>;
/** One supported tracker; the value of project.json "issueTracker". */
export type IssueTrackerKind = keyof typeof ISSUE_TRACKERS;
export const ISSUE_TRACKER_KINDS = Object.keys(ISSUE_TRACKERS) as IssueTrackerKind[];
export const ISSUE_TRACKER_DENIED_TOOLS = ISSUE_TRACKER_KINDS.flatMap(k => ISSUE_TRACKERS[k].agentDeniedTools);

export const createIssueTracker = (kind: IssueTrackerKind, lookup: EnvLookup, fetchFn?: typeof fetch): IssueTracker =>
  ISSUE_TRACKERS[kind].create(lookup, fetchFn);
