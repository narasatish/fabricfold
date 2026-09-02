import type { Metadata } from "next";
import MarketingShell from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "Terms & Conditions — FabricFold",
  description:
    "The terms you agree to when you use FabricFold: orders and pricing, cancellation, what we can't accept, garment care and our liability limit, payments, subscriptions, collection, and how we handle problems.",
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
            booking an order or handing us your clothes, you accept them. Please read <strong>section 9</strong> — it
            limits what we pay if a garment is damaged or lost.
          </p>

          <h2 className="m-h2">1. Who we are, and who can use FabricFold</h2>
          <p>
            FabricFold is operated by <strong>FabricFold Laundry Solutions</strong> (&ldquo;FabricFold&rdquo;,
            &ldquo;we&rdquo;, &ldquo;us&rdquo;), and in these terms &ldquo;you&rdquo; means the person whose account
            placed the order. We run managed laundry counters at partner campuses and communities in Telangana, India. The service
            is available only to students, residents and staff of a campus or community we operate at, and you must be 18
            or over to hold an account. We may ask you to prove you belong to that campus.
          </p>

          <h2 className="m-h2">2. Your account</h2>
          <p>
            We sign you in with a one-time password sent to your mobile number. Keep your number and phone secure —
            anyone who receives that code can access your account and collect your laundry. Tell us immediately if you
            think someone else has access. One account per person; accounts are personal and may not be shared, sold or
            transferred. You are responsible for orders placed from your account.
          </p>

          <h2 className="m-h2">3. Booking an order</h2>
          <p>
            When you book in the app you are telling us what you <em>intend</em> to bring. <strong>That booking is not
            the final bill.</strong> When you hand the clothes in, our counter staff count and weigh what is actually
            there, tag each garment, and price the order on that verified count. If what you bring differs from what you
            declared, the counter count is what you pay for.
          </p>
          <p>
            Where your campus offers drop-off slots, booking one reserves you a place in that window. Slots have limited
            capacity and are first-come, first-served. A slot is a convenience, not a guarantee of an exact service time,
            and you can still drop in without one.
          </p>

          <h2 className="m-h2">4. Cancelling an order</h2>
          <ul>
            <li><strong>Before you hand the clothes in</strong> — cancel free in the app at any time. Nothing has been
              charged.</li>
            <li><strong>After we have accepted the clothes but not started cleaning</strong> — tell us straight away. If
              we can still stop the order, we will return your clothes uncleaned at no charge.</li>
            <li><strong>Once cleaning has started</strong> — the order can no longer be cancelled, because the service is
              being performed. Any promotional discount applied to a cancelled order is void.</li>
          </ul>
          <p>
            <strong>We may cancel or refuse an order</strong> if we can&apos;t process it safely, if equipment or
            services are unavailable, in the event of a campus closure, natural disaster, lockdown or similar, if our
            staff face a safety concern, or if we suspect fraud. If we cancel, you pay nothing for that order and
            anything already paid is returned to your wallet.
          </p>

          <h2 className="m-h2">5. What we can&apos;t accept</h2>
          <p>Please don&apos;t hand in:</p>
          <ul>
            <li>anything hazardous, flammable, contaminated with chemicals, or biologically soiled;</li>
            <li>items infested with pests;</li>
            <li>anything illegal, or anything that isn&apos;t yours to give us;</li>
            <li>wet or mildewed items sealed in a bag, which can ruin an entire load; or</li>
            <li>items of exceptional value — heirlooms, designer or couture pieces, leather, fur, wedding wear, or
              anything irreplaceable. See section 9 for why.</li>
          </ul>
          <p>
            We may refuse or return any such item, and we don&apos;t offer alterations, repairs or dyeing.
          </p>

          <h2 className="m-h2">6. Your responsibilities before handing clothes in</h2>
          <ul>
            <li><strong>Empty your pockets</strong> and remove pins, badges and detachable trims.</li>
            <li><strong>Tell us about anything special</strong> — a delicate fabric, a stain and what caused it, a
              garment that has bled colour before, or an item you are worried about. We can only take extra care if we
              know.</li>
            <li><strong>Check the care label is present and readable.</strong> We clean to the care label. If there is no
              label, or it is unreadable, we clean using our best judgement <strong>at your risk</strong>.</li>
          </ul>
          <p>
            Our scales and our counter count are what the bill is based on. If you disagree, raise it at the counter
            before you leave — that is the point at which we can recount with you.
          </p>

          <h2 className="m-h2">7. Prices, GST and express</h2>
          <p>
            Prices are set per campus and shown in the app before you confirm. GST is added at the applicable rate and
            shown separately — you always see the subtotal, tax and total before you pay. Express (same-day) service
            costs a flat same-day fee (₹99 Wash & Iron, ₹79 Wash & Fold and Dry Cleaning), where your campus offers it.
          </p>
          <p>
            We may change prices from time to time. The price that applies to your order is the one shown when the order
            is accepted at the counter.
          </p>

          <h2 className="m-h2">8. Turnaround</h2>
          <p>
            Standard orders are normally ready in about 48 hours from when we receive them, and express orders the same
            day. These are targets, not guarantees — weather, power cuts, water supply, equipment failure and campus
            holidays can delay us. If your order will be late we will tell you in the app. A delay alone doesn&apos;t
            entitle you to a refund, but see section 14 and our{" "}
            <a href="/refunds">Refunds &amp; Compensation policy</a>.
          </p>

          <h2 className="m-h2">9. Garment care and our liability</h2>
          <p>
            We process every garment with reasonable care using standard methods, and we photograph existing stains or
            damage when you hand clothes in so both of us have a record.
          </p>
          <p><strong>We are not responsible for:</strong></p>
          <ul>
            <li>anything left in pockets or attached to a garment — cash, jewellery, cards, keys, pins, badges;</li>
            <li>damage or wear that already existed when you handed the garment in;</li>
            <li>colour bleeding, shrinkage, stretching, fading or texture change that happens during normal cleaning,
              where the garment was cleaned according to its care label;</li>
            <li>garments with no care label or an unreadable one — cleaned at your risk;</li>
            <li>stains that cannot be removed without damaging the fabric — we would rather return a stained garment
              than a ruined one;</li>
            <li>ordinary wear and tear, or a garment already at the end of its life; or</li>
            <li>delay or loss caused by events outside our reasonable control (section 18).</li>
          </ul>
          <p>
            <strong>Where we are genuinely at fault</strong> — we lose a garment, or damage it through our own negligence
            — our liability for that garment is limited to <strong>ten times the wash charge for that garment, or the
            garment&apos;s actual value, whichever is lower</strong>. This is the standard limit across the laundry
            industry, and it is what lets us charge a few rupees to wash a shirt rather than pricing in the risk of
            replacing it. Please don&apos;t give us items you couldn&apos;t accept losing at that limit.
          </p>
          <p>
            Our total liability for any one order will not exceed that limit applied across the affected garments, and we
            are not liable for indirect or consequential loss — for example, missing an event because an order was late.
          </p>
          <p>
            <strong>Nothing in these terms limits any liability that cannot be limited by law</strong>, including your
            rights under the Consumer Protection Act, 2019.
          </p>

          <h2 className="m-h2">10. Collecting your clothes</h2>
          <p>
            We notify you when your order is ready. To collect, show your order code or FabricFold ID at the counter — we
            verify it before handing anything over, which is how we stop someone else walking off with your laundry. If
            you want a friend to collect for you, send them with your order code; we treat whoever presents a valid code
            as authorised by you.
          </p>
          <p>
            Please collect promptly. We hold ready orders for <strong>30 days</strong> from the day we tell you they are
            ready, and we will remind you before that runs out. After 30 days we may dispose of or donate uncollected
            garments, and no compensation is payable for items disposed of this way. Anything you owe on the order
            remains payable.
          </p>

          <h2 className="m-h2">11. Payment and wallet credit</h2>
          <p>
            You can pay by cash, UPI, wallet credit, or by using a cycle from a subscription plan. Payment is due when
            you collect, unless your plan covers the order. Online payments are handled by our payment provider — we
            never see or store your card details or UPI PIN. We may refuse further service while an amount is unpaid.
          </p>
          <p>
            Wallet credit is money you have already paid us, or compensation we have issued. It can be spent only on
            FabricFold services, is not transferable to another person, and cannot be withdrawn as cash. Credit
            representing money you actually paid does not expire; promotional or goodwill credit may carry an expiry,
            which we will tell you about when we issue it.
          </p>

          <h2 className="m-h2">12. Subscription plans</h2>
          <p>
            Plans are specific to your campus and cover a set number of cycles for a set service, each up to a weight
            limit. A cycle is consumed when an order is accepted against your plan, whether or not you use the full
            weight allowance. Weight above the per-cycle limit is charged as an extra. Unused cycles do not roll over
            after the plan ends, and plans are personal to you and non-transferable.
          </p>
          <p>
            <strong>Subscription fees are not refundable</strong> once the plan is activated. If we stop operating at
            your campus during your plan, we will credit you fairly for the cycles you have not used.
          </p>

          <h2 className="m-h2">13. Offers and discounts</h2>
          <p>
            Offers are limited to one per order unless we say otherwise, can&apos;t be exchanged for cash, and may be
            withdrawn or changed at any time. A discount used on an order that is later cancelled is void, not returned.
            We may cancel an order and withdraw credit where an offer has been abused — for example, multiple accounts
            created for the same person.
          </p>

          <h2 className="m-h2">14. If something goes wrong</h2>
          <p>
            Tell us within <strong>48 hours</strong> of collecting, while we can still investigate — raise it in the app
            under Help, or at the counter. Our full approach is in the{" "}
            <a href="/refunds">Refunds &amp; Compensation policy</a>. In short: we fix problems with a free re-do, wallet
            credit or compensation rather than cash.
          </p>

          <h2 className="m-h2">15. Messages we send you</h2>
          <p>
            By using FabricFold you agree we can contact you about your orders by SMS, WhatsApp, push notification,
            email and phone — these are service messages and you can&apos;t opt out of them while you have an active
            order, because they are how we tell you your clothes are ready. You can turn off push notifications and
            marketing messages at any time without losing access to the service.
          </p>

          <h2 className="m-h2">16. Using the app properly</h2>
          <p>
            Please don&apos;t use FabricFold for anything unlawful, don&apos;t try to access parts of the system that
            aren&apos;t yours, don&apos;t interfere with the service or other people&apos;s orders, and don&apos;t
            attempt to copy, scrape or resell it. We ask that you treat our counter staff with respect — we will refuse
            service to anyone who abuses, threatens or harasses them.
          </p>

          <h2 className="m-h2">17. Suspending or closing an account</h2>
          <p>
            We may suspend or close your account if you break these terms, abuse our staff, or use the service
            fraudulently. If we do, wallet credit representing money you actually paid remains yours and we will return
            it; promotional or goodwill credit may be withdrawn. You can close your account at any time — see the{" "}
            <a href="/privacy">Privacy Policy</a> for what happens to your data.
          </p>

          <h2 className="m-h2">18. Events outside our control</h2>
          <p>
            We are not liable for failure or delay caused by something beyond our reasonable control — power or water
            failure, floods or storms, strikes, civil unrest, epidemics, government restrictions, campus closure, or
            failure of a third-party network or payment provider. If such an event lasts long enough to make the order
            pointless, we will return your garments and refund what you paid for it to your wallet.
          </p>

          <h2 className="m-h2">19. Our content</h2>
          <p>
            The FabricFold name, logo, app and website content belong to us. You may use the app to run your own laundry
            orders — please don&apos;t copy, resell or republish our content without our permission.
          </p>

          <h2 className="m-h2">20. Services we rely on</h2>
          <p>
            FabricFold uses third-party providers for hosting, payments, messaging and error monitoring. How they handle
            your data is covered in our <a href="/privacy">Privacy Policy</a>. We are not responsible for failures in
            services we don&apos;t control — for example, your mobile network not delivering an OTP.
          </p>

          <h2 className="m-h2">21. Changes to these terms</h2>
          <p>
            We may update these terms. The version that applies to your order is the one published when the order was
            accepted. We will change the date at the top when we update this page, and tell you in the app if the change
            is significant.
          </p>

          <h2 className="m-h2">22. General</h2>
          <p>
            If any part of these terms turns out to be unenforceable, the rest still applies. If we don&apos;t enforce a
            term straight away, we haven&apos;t given up the right to enforce it later. We may transfer our rights and
            obligations under these terms to another business — for example if FabricFold is sold — and your rights
            won&apos;t be reduced by that. You may not transfer yours. These terms, with the Privacy Policy and Refunds
            policy, are the whole agreement between us. Notices to you go to the mobile number or email on your account.
          </p>

          <h2 className="m-h2">23. Governing law and disputes</h2>
          <p>
            These terms are governed by the laws of India, and the courts of Telangana have jurisdiction. Please talk to
            us first — most problems are settled at the counter in minutes. Nothing here takes away your right to
            approach a consumer forum.
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
