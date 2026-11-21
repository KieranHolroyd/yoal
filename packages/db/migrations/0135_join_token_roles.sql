-- The roles a join token allows (HA Wave 5 lane B review). A join may request a subset of them and
-- is refused if it asks for more; NULL (every existing token) allows none, so such a node joins
-- with today's defaults. A token can no longer be used to make a node an ingress, which would hand
-- it the shared certificate and session secrets.
ALTER TABLE node_join_tokens ADD COLUMN roles_json TEXT;
