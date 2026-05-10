import { WebClient as SlackClient } from "@slack/web-api";

const token = process.env["SLACK_BOT_TOKEN"];
if (!token) {
  console.error("SLACK_BOT_TOKEN is required");
  process.exit(1);
}

const slack = new SlackClient(token);
const res = await slack.usergroups.list({ include_users: false });
const groups = res.usergroups ?? [];
if (groups.length === 0) {
  console.log("No user groups found.");
  process.exit(0);
}

console.log(`Found ${groups.length} user group(s):\n`);
for (const g of groups) {
  console.log(`  id      : ${g.id}`);
  console.log(`  name    : ${g.name}`);
  console.log(`  handle  : @${g.handle}`);
  console.log(`  members : ${g.user_count ?? "?"}`);
  console.log("");
}
