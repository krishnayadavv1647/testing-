// One-off migration: custom-provider agents should use custom_ai telephony inbound mode.
//
// Run with:  node scripts/migrateCustomTelephonyInboundMode.js          (dry run)
//            node scripts/migrateCustomTelephonyInboundMode.js --apply   (write changes)
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import Agent from "../src/models/Agent.js";
import TelephonyConfig from "../src/models/TelephonyConfig.js";

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDB();

  const configs = await TelephonyConfig.find({
    inboundMode: "dograh_ai",
    linkedAgentId: { $ne: null },
    status: "active"
  }).select("_id name provider phoneNumber linkedAgentId inboundMode");

  let changed = 0;
  for (const config of configs) {
    const agent = await Agent.findById(config.linkedAgentId).select("_id agentName name provider");
    if (!agent || agent.provider === "dograh") continue;

    console.log(`${config.name || config.phoneNumber}: ${config.inboundMode} -> custom_ai (agent=${agent.agentName || agent.name}, provider=${agent.provider || "custom"})`);
    if (apply) {
      await TelephonyConfig.updateOne(
        { _id: config._id, inboundMode: "dograh_ai" },
        {
          $set: {
            inboundMode: "custom_ai",
            inboundRoutingStatus: "not_configured",
            inboundRoutingError: "",
            inboundRoutingVerifiedAt: null
          }
        }
      );
    }
    changed += 1;
  }

  console.log(apply ? `Applied ${changed} updates.` : `Dry run: ${changed} configs would change. Re-run with --apply.`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
