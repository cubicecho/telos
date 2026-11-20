-- agent-mcp-pool 4 names the exchange's hook events beforeExchange and
-- afterExchange, with no aliases: a hook still bound to beforeTurn or afterTurn
-- fails validation, and the runner drops every hook on that server. Rename them
-- in place, keeping each hook's other fields and the array's order.
UPDATE "mcp_servers"
SET "hooks" = (
  SELECT jsonb_agg(
    CASE hook->>'on'
      WHEN 'beforeTurn' THEN jsonb_set(hook, '{on}', '"beforeExchange"')
      WHEN 'afterTurn' THEN jsonb_set(hook, '{on}', '"afterExchange"')
      ELSE hook
    END
    ORDER BY position
  )
  FROM jsonb_array_elements("hooks") WITH ORDINALITY AS entry(hook, position)
)
WHERE jsonb_typeof("hooks") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("hooks") AS entry(hook)
    WHERE hook->>'on' IN ('beforeTurn', 'afterTurn')
  );
