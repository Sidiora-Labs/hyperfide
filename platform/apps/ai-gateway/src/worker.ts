export default {
  async fetch(): Promise<Response> {
    return Response.json(
      { error: "Hosted accounts are disabled" },
      { status: 503 },
    );
  },
} satisfies ExportedHandler;
