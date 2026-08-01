DROP INDEX IF EXISTS "Message_search_fts_idx";

CREATE INDEX "Message_search_fts_idx"
ON "Message"
USING GIN (
  (
    to_tsvector(
      'russian'::regconfig,
      coalesce("text", '') || ' ' ||
      coalesce("summary", '') || ' ' ||
      coalesce("searchText", '')
    ) ||
    to_tsvector(
      'english'::regconfig,
      coalesce("text", '') || ' ' ||
      coalesce("summary", '') || ' ' ||
      coalesce("searchText", '')
    )
  )
);
