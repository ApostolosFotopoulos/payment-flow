-- Runs once, when the postgres data directory is empty.
-- The Jest suite needs its own database so tests can TRUNCATE freely without
-- touching development data.
CREATE DATABASE payment_flow_test;