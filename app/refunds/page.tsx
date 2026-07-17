import type { Metadata } from "next";
import MarketingShell from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "Refunds, Compensation & Complaints — FabricFold",
  description:
    "How FabricFold puts things right: free re-dos, wallet credit and compensation, what we pay for a damaged or lost garment, how to raise a complaint, and how to escalate it.",
  alternates: { canonical: "https://fabricfold.in/refunds" },
};

const UPDATED = "17 July 2026";

export default function Refunds() {
  return (
    <MarketingShell active="/refunds">
      <header className="mx m-sec tight" style={{ textAlign: "center" }}>
        <span className="m-kicker">Legal</span>
        <h1 className="m-h1" style={{ maxWidth: 760, margin: "18px auto 0" }}>Refunds, Compensation &amp; Complaints</h1>
        <p className="m-sub" style={{ marginTop: 12 }}>Last updated: {UPDATED}</p>
      </header>

      <section className="m-sec" style={{ paddingTop: 8 }}>
        <div className="mx m-prose">
          <p>
            If we get your laundry wrong, we fix it. This page says exactly how — what we do, what we pay, how quickly,
            and what to do if you&apos;re not happy with our answer. It applies to services provided by{" "}
            <strong>FabricFold Laundry Solutions</strong> and sits alongside our{" "}
            <a href="/terms">Terms &amp; Conditions</a>.
          </p>

          <h2 className="m-h2">The short version</h2>
          <p>
            <strong>We put things right with a free re-do, wallet credit or compensation — not cash.</strong> Once we
            have washed your clothes the service has been performed, so we don&apos;t give cash refunds for
            change-of-mind. But if the fault is ours, you are never left out of pocket: we re-do it free, or credit you,
            and for genuine loss or damage we pay compensation under the limit below.
          </p>

          <h2 className="m-h2">Not happy with the wash?</h2>
          <p>
            Tell us within <strong>48 hours</strong> of collecting — raise it in the app under Help, or at the counter.
            If a garment has come back still stained or not properly cleaned, we will <strong>re-wash it free</strong>.
            That is usually the fastest and best outcome for everyone, and it is our first response.
          </p>

          <h2 className="m-h2">Damaged, lost or missing garments</h2>
          <p>
            Report it within <strong>48 hours</strong> of collection (or as soon as you notice a garment is missing from
            an order). We check the order — every garment is QR-tagged, and we photograph existing damage when you hand
            clothes in, so we can usually establish quickly what happened.
          </p>
          <p>
            If the fault is ours, we compensate you. As set out in our Terms, compensation for a garment is capped at{" "}
            <strong>ten times the wash charge for that garment, or the garment&apos;s actual value, whichever is
            lower</strong>. This is the standard limit across the laundry industry and it is what lets us charge ₹15 to
            wash a shirt rather than pricing in the risk of replacing it.
          </p>
          <p>
            Compensation is normally paid as <strong>wallet credit</strong>, which you can spend on any FabricFold
            service. Where credit genuinely isn&apos;t appropriate, a manager can approve a cash payment.
          </p>
          <p>
            We don&apos;t compensate for the things listed in section 5 of our <a href="/terms">Terms</a> — items left in
            pockets, damage that was already there, or normal-cleaning effects like shrinkage on a garment cleaned to its
            care label.
          </p>

          <h2 className="m-h2">When you get money back</h2>
          <p>You get a refund of what you paid in these cases:</p>
          <ul>
            <li><strong>You cancel before we start.</strong> If your order is still a booking and we haven&apos;t taken
              your clothes in, cancel it in the app — nothing has been charged.</li>
            <li><strong>We cancel or can&apos;t do the job.</strong> If we accept an order and then can&apos;t complete
              it, you pay nothing for it, and anything already paid goes back to your wallet.</li>
            <li><strong>You were charged incorrectly.</strong> If we billed you for the wrong count, the wrong service or
              the wrong price, we correct it and return the difference. Tell us and we&apos;ll check the order record.</li>
          </ul>
          <p>
            In each case the money is returned as wallet credit by default, and we issue a proper GST credit note against
            the original invoice where one was raised. If you have left the campus for good and can&apos;t use the
            credit, contact us and a manager will arrange to return it to you.
          </p>

          <h2 className="m-h2">Subscription plans</h2>
          <p>
            <strong>Plan fees are not refundable once the plan is activated</strong>, and unused cycles don&apos;t roll
            over or convert to cash. Individual orders under a plan are still covered by everything above — if we damage
            a garment on a plan order, you are compensated the same way. If we stop operating at your campus mid-plan, we
            will credit you fairly for the cycles you haven&apos;t used.
          </p>

          <h2 className="m-h2">Express orders</h2>
          <p>
            If you paid the express surcharge and we fail to deliver same-day through our own fault, we refund the{" "}
            <strong>express surcharge</strong> to your wallet — you still pay the normal wash price, because you still
            got the wash.
          </p>

          <h2 className="m-h2">How to raise a complaint</h2>
          <ol>
            <li><strong>In the app</strong> — open Help and describe the problem. It goes straight to the counter team
              and you can chat with them in the thread. This is the fastest route and it creates a record.</li>
            <li><strong>At the counter</strong> — talk to the staff on duty. They can order a free re-do or issue credit
              on the spot.</li>
            <li><strong>Email or WhatsApp</strong> — <a href="mailto:support@fabricfold.in">support@fabricfold.in</a> or{" "}
              <a href="tel:+918019121966">+91 80191 21966</a>.</li>
          </ol>
          <p>
            <strong>What happens next:</strong> we acknowledge within <strong>1 working day</strong> and aim to resolve
            within <strong>3 working days</strong>. If we need longer — for example to search for a garment — we tell you
            why and when to expect an answer. Every complaint and every credit or compensation we issue is logged
            against the order, so nothing depends on who you spoke to or what was remembered.
          </p>

          <h2 className="m-h2">If you&apos;re still not satisfied</h2>
          <p>
            Ask for it to be escalated to the FabricFold owner, at{" "}
            <a href="mailto:support@fabricfold.in">support@fabricfold.in</a> with your order number — the owner sees
            every complaint and will review it personally. If you are still unhappy after that, you can approach the
            consumer forum for your district. Nothing in this policy affects your rights under the Consumer Protection
            Act, 2019.
          </p>

          <h2 className="m-h2">Contact</h2>
          <p>
            Email: <a href="mailto:support@fabricfold.in">support@fabricfold.in</a>
            <br />
            WhatsApp / phone: <a href="tel:+918019121966">+91 80191 21966</a>
          </p>
        </div>
      </section>
    </MarketingShell>
  );
}
