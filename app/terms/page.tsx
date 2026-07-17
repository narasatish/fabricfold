import type { Metadata } from "next";
import MarketingShell from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "Terms & Conditions — FabricFold",
  description:
    "The terms you agree to when you use FabricFold: how orders and pricing work, garment care and our liability limit, payments, subscriptions, collection, and how we handle problems.",
  alternates: { canonical: "https://fabricfold.in/terms" },
};

const UPDATED = "17 July 2026";

export default function Terms() {
  return (
    <MarketingShell active="/terms">
      <header className="mx m-sec tight" style={{ textAlign: "center" }}>
        <span className="m-kicker">Legal</span>
        <h1 className="m-h1" style={{ maxWidth: 720, margin: "18px auto 0" }}>Terms &amp; Conditions</h1>
        <p className="m-sub" style={{ marginTop: 12 }}>Last updated: {UPDATED}</p>
      </header>

      <section className="m-sec" style={{ paddingTop: 8 }}>
        <div className="mx m-prose">
          <p>
            These terms apply when you use the FabricFold app or website, or hand laundry in at a FabricFold counter. By
            booking an order or handing us your clothes, you accept them. Please read the section on garment care and
            liability — it limits what we pay if something goes wrong.
          </p>

          <h2 className="m-h2">1. Who we are and who can use FabricFold</h2>
          <p>
            FabricFold runs managed laundry counters at partner campuses and communities in Telangana. The service is
            available only to students, residents and staff of a campus or community we operate at, and you must be 18 or
            over to hold an account. We sign you in with a one-time password sent to your mobile number — keep your
            number and phone secure, because anyone who receives that code can access your account.
          </p>

          <h2 className="m-h2">2. Booking an order</h2>
          <p>
            When you book in the app you are telling us what you <em>intend</em> to bring. That booking is not the final
            bill. When you hand the clothes in, our counter staff count and weigh what is actually there, tag each
            garment, and the order is priced on that verified count. If what you bring differs from what you declared,
            the counter count is what you pay for.
          </p>
          <p>
            Where your campus offers drop-off slots, booking one reserves you a place in that window. Slots have a
            limited capacity and are first-come, first-served. A slot is a convenience, not a guarantee of an exact
            service time, and you can still drop in without one.
          </p>

          <h2 className="m-h2">3. Prices, GST and express</h2>
          <p>
            Prices are set per campus and shown in the app before you confirm. GST is added at the applicable rate and
            shown separately on your bill — you always see the subtotal, tax and total before you pay. Express
            (same-day) service costs an additional 40% of the order value and is available where your campus offers it.
          </p>
          <p>
            We may change prices from time to time. The price that applies to your order is the one shown when the order
            is accepted at the counter.
          </p>

          <h2 className="m-h2">4. Turnaround</h2>
          <p>
            Standard orders are normally ready in about 48 hours from the time we receive them, and express orders the
            same day. These are targets, not guarantees — weather, power cuts, equipment failure and campus holidays can
            delay us. If your order will be late, we will tell you in the app. A delay on its own does not entitle you to
            a refund, but see section 9 if the delay causes you a real problem.
          </p>

          <h2 className="m-h2">5. Garment care and our liability</h2>
          <p>
            We process every garment with reasonable care using standard methods, and we photograph existing stains or
            damage when you hand clothes in so that both of us have a record.
          </p>
          <p>
            <strong>We are not responsible for:</strong>
          </p>
          <ul>
            <li>anything left in pockets or attached to a garment — cash, jewellery, cards, keys, pins or badges;</li>
            <li>damage or wear that already existed when you handed the garment in;</li>
            <li>colour bleeding, shrinkage, stretching or fading that happens during normal cleaning, where the garment
              was cleaned according to its care label;</li>
            <li>garments with no care label, or where the label is unreadable — we clean these at your risk;</li>
            <li>stains that cannot be removed without damaging the fabric; and</li>
            <li>delay or loss caused by events outside our reasonable control.</li>
          </ul>
          <p>
            <strong>Where we are genuinely at fault</strong> — we lose a garment, or damage it through our own negligence
            — our liability for that garment is limited to <strong>ten times the wash charge for that garment, or the
            garment&apos;s actual value, whichever is lower</strong>. This is the standard limit across the laundry
            industry and it lets us keep prices low. Please do not give us items whose value you could not accept losing
            at that limit — heirlooms, designer pieces, leather, or anything irreplaceable.
          </p>
          <p>
            Nothing in these terms limits any liability that cannot be limited by law, including your rights under
            Indian consumer protection law.
          </p>

          <h2 className="m-h2">6. Collecting your clothes</h2>
          <p>
            We notify you when your order is ready. To collect, show your order code or FabricFold ID at the counter — we
            verify it before handing anything over, which is how we stop someone else walking off with your laundry.
          </p>
          <p>
            Please collect promptly. We hold ready orders for <strong>30 days</strong> from the day we tell you they are
            ready. We will remind you before that runs out. After 30 days we may dispose of or donate uncollected
            garments, and no compensation is payable for items disposed of this way. Any amount you owe on the order
            remains payable.
          </p>

          <h2 className="m-h2">7. Payment and wallet</h2>
          <p>
            You can pay by cash, UPI, wallet credit, or by using a cycle from a subscription plan. Payment is due when
            you collect, unless your plan covers the order. Online payments are handled by our payment provider — we
            never see or store your card details or UPI PIN.
          </p>
          <p>
            Wallet credit is money you have already paid us, or compensation we have issued. It can be spent only on
            FabricFold services, is not transferable to another person, and cannot be withdrawn as cash.
          </p>

          <h2 className="m-h2">8. Subscription plans</h2>
          <p>
            Plans are specific to your campus and cover a set number of cycles for a set service, each up to a weight
            limit. A cycle is consumed when an order is accepted against your plan, whether or not you use the full
            weight allowance. Weight above the per-cycle limit is charged as an extra. Unused cycles do not roll over
            after the plan ends, and plans are personal to you.
          </p>
          <p>
            <strong>Subscription fees are not refundable</strong> once the plan is activated. If we stop operating at
            your campus during your plan, we will credit you fairly for the cycles you have not used.
          </p>

          <h2 className="m-h2">9. If something goes wrong</h2>
          <p>
            Tell us within <strong>48 hours</strong> of collecting, while we can still investigate — raise it in the app
            or at the counter. Our full approach, including what we pay and how fast, is set out in our{" "}
            <a href="/refunds">Refunds &amp; Compensation policy</a>. In short: we fix problems with a free re-do, wallet
            credit or compensation rather than cash.
          </p>

          <h2 className="m-h2">10. Using the app properly</h2>
          <p>
            Please don&apos;t use FabricFold for anything unlawful, don&apos;t try to access parts of the system that
            aren&apos;t yours, don&apos;t attempt to interfere with the service or other users&apos; orders, and
            don&apos;t give us items that are hazardous, contaminated or illegal. We may refuse or cancel an order at our
            discretion — for example if it is unsafe to process, or if we suspect fraud.
          </p>

          <h2 className="m-h2">11. Suspending an account</h2>
          <p>
            We may suspend or close your account if you break these terms, abuse our staff, or use the service
            fraudulently. If we do, any wallet credit that represents money you actually paid us remains yours and we
            will return it; promotional or goodwill credit may be withdrawn.
          </p>

          <h2 className="m-h2">12. Our content</h2>
          <p>
            The FabricFold name, logo, app and website content belong to us. You may use the app to run your own laundry
            orders — please don&apos;t copy, resell or republish our content without our permission.
          </p>

          <h2 className="m-h2">13. Services we rely on</h2>
          <p>
            FabricFold uses third-party providers for hosting, payments, messaging and error monitoring. Their handling
            of your data is covered in our <a href="/privacy">Privacy Policy</a>. We are not responsible for failures in
            services we don&apos;t control, such as your mobile network not delivering an OTP.
          </p>

          <h2 className="m-h2">14. Changes to these terms</h2>
          <p>
            We may update these terms. The version that applies to your order is the one published when the order was
            accepted. We will change the date at the top when we update this page, and tell you in the app if the change
            is significant.
          </p>

          <h2 className="m-h2">15. Governing law</h2>
          <p>
            These terms are governed by the laws of India, and the courts of Telangana have jurisdiction. Nothing here
            takes away your right to approach a consumer forum.
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
