process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://payment:payment@localhost:5432/payment_flow_test";
process.env.DATABASE_URL ??= "postgres://payment:payment@localhost:5432/payment_flow_test";
