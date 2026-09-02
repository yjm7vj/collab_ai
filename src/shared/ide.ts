export type IdeCursor = {
  uid: string;
  name: string;
  path: string;
  line: number;
  column: number;
  color: string;
};

export type IdeActivity = {
  id: string;
  uid: string;
  name: string;
  kind: "opened" | "edited" | "saved" | "indexed";
  path: string;
  detail: string;
  at: number;
};
