/**
 * fix_bookings_migration.js
 *
 * Migration script to assign `userId` for legacy bookings that have userId=null/missing.
 *
 * How it works:
 *  - Connects to MongoDB using MONGO_URI env var or default mongodb://localhost:27017/flight_booking_dev
 *  - Finds bookings where userId is null, missing or empty string.
 *  - Attempts to match a user by contact.email (case-insensitive) or contact.phone.
 *  - If a user is found, sets booking.userId = user's _id (string)
 *  - Supports --dry-run to only log actions without modifying DB
 *  - Supports --assign-to <userId> to force-assign all matched bookings to a given user id
 *  - Supports --backup <file.json> to write matched bookings to JSON before applying changes
 *
 * Usage:
 *   npm install mongodb
 *   node fix_bookings_migration.js --dry-run
 *   node fix_bookings_migration.js --backup before.json
 *   node fix_bookings_migration.js --assign-to <userId>
 */

const { MongoClient, ObjectId } = require("mongodb");
const fs = require("fs");
const path = require("path");

const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb://localhost:27017/flight_booking_dev";

const DB_NAME = (() => {
  try {
    const m = MONGO_URI.match(/\/([A-Za-z0-9_-]+)(\?|$)/);
    if (m && m[1]) return m[1];
  } catch (e) {}
  return "flight_booking_dev";
})();

const argv = process.argv.slice(2);
const opts = {
  dryRun: argv.includes("--dry-run"),
  assignTo: null,
  backupFile: null,
};

for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === "--assign-to" || argv[i] === "-a") && argv[i + 1]) {
    opts.assignTo = argv[i + 1];
    i++;
  } else if ((argv[i] === "--backup" || argv[i] === "-b") && argv[i + 1]) {
    opts.backupFile = argv[i + 1];
    i++;
  }
}

(async function main() {
  console.log("Migration start: connecting to", MONGO_URI, "DB:", DB_NAME);
  console.log("Options:", opts);

  const client = new MongoClient(MONGO_URI, {
    useUnifiedTopology: true,
  });

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const bookings = db.collection("bookings");
    const users = db.collection("users");

    const query = {
      $or: [
        { userId: { $exists: false } },
        { userId: null },
        { userId: "" },
      ],
    };

    const rows = await bookings.find(query).sort({ createdAt: 1 }).toArray();
    console.log("Bookings with missing userId:", rows.length);

    if (rows.length === 0) {
      console.log("Nothing to update.");
      return;
    }

    if (opts.backupFile) {
      const outPath = path.resolve(process.cwd(), opts.backupFile);
      fs.writeFileSync(outPath, JSON.stringify(rows, null, 2), "utf8");
      console.log("Backup saved to:", outPath);
    }

    const updates = [];

    for (const b of rows) {
      const rec = {
        bookingId: b._id.toString(),
        bookingRef: b.bookingRef || null,
        matchedUserId: null,
        reason: null,
      };

      if (opts.assignTo) {
        updates.push({
          booking: b,
          action: "assign",
          userId: opts.assignTo,
          rec,
        });
        continue;
      }

      const email = b.contact?.email?.toLowerCase?.() || null;
      const phone = b.contact?.phone || null;

      let user = null;

      // Email exact match
      if (email) {
        user = await users.findOne({ email: email });
        if (user) {
          rec.matchedUserId = user._id.toString();
          rec.reason = "email-exact";
          updates.push({ booking: b, action: "assign", userId: rec.matchedUserId, rec });
          continue;
        }
      }

      // Phone match
      if (phone) {
        user = await users.findOne({ phone: phone });
        if (user) {
          rec.matchedUserId = user._id.toString();
          rec.reason = "phone-exact";
          updates.push({ booking: b, action: "assign", userId: rec.matchedUserId, rec });
          continue;
        }
      }

      // Email regex case-insensitive
      if (email) {
        user = await users.findOne({
          email: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
        });
        if (user) {
          rec.matchedUserId = user._id.toString();
          rec.reason = "email-regex";
          updates.push({ booking: b, action: "assign", userId: rec.matchedUserId, rec });
          continue;
        }
      }

      rec.reason = "no-match";
      updates.push({ booking: b, action: "skip", rec });
    }

    const toAssign = updates.filter((u) => u.action === "assign");
    const toSkip = updates.filter((u) => u.action === "skip");

    console.log("Bookings to assign:", toAssign.length);
    console.log("Bookings skipped:", toSkip.length);

    if (opts.dryRun) {
      console.log("\n--- DRY RUN OUTPUT ---");
      updates.forEach((u) => console.log(u.rec));
      console.log("--- END ---");
      return;
    }

    let applied = 0;

    for (const u of toAssign) {
      const id = u.booking._id;
      const newUserId = u.userId;

      const r = await bookings.updateOne(
        { _id: id },
        { $set: { userId: String(newUserId) } }
      );

      if (r.modifiedCount > 0) applied++;

      console.log(
        `[APPLIED] booking ${id.toString()} → userId=${newUserId} (${u.rec.reason})`
      );
    }

    console.log(`Migration done. Updated ${applied}/${toAssign.length} bookings.`);

  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    client.close();
  }
})();

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
