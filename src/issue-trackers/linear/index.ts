import type { IssueTrackerDescriptor } from "../../issue-tracker.js";
import {
  TODO_STATE, fetchIssueSnapshots, fetchTeams, fetchTicket, fetchTodoIssues,
  isFinished, linearClient, setIssueState, shouldMarkInProgress,
} from "./client.js";

export const linear: IssueTrackerDescriptor = {
  create: (lookup, fetchFn) => {
    const client = () => linearClient(lookup, fetchFn);
    return {
      getIssue: async identifier => {
        const ticket = await fetchTicket(identifier, client());
        if (!ticket) return null;
        const { stateType, inProgressState, inReviewState, ...rest } = ticket;
        return {
          ...rest,
          startTarget: shouldMarkInProgress(stateType) ? inProgressState : undefined,
          reviewTarget: isFinished(stateType) ? undefined : inReviewState,
        };
      },
      moveIssue: async (issue, to) => setIssueState(issue.id, to.id, client()),
      listTodo: async () =>
        (await fetchTodoIssues(client())).map(({ id: _id, ...rest }) => ({ ...rest, state: TODO_STATE })),
      getSnapshots: async identifiers => {
        const snapshots = await fetchIssueSnapshots(client(), identifiers);
        return Object.fromEntries(
          Object.entries(snapshots).map(([id, s]) => [id, s && { ...s, ready: s.state === TODO_STATE }]),
        );
      },
      listTeams: async () => fetchTeams(client()),
    };
  },
  envKeys: ["LINEAR_API_KEY"],
  agentDeniedTools: ["mcp__claude_ai_Linear"],
};
