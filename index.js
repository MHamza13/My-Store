const express = require("express");
require("dotenv").config();
require("./db/DbConnection");
const server = express();
const productRouter = require("./routes/Products");
const brandsRouter = require("./routes/Brand");
const categoriesRouter = require("./routes/Category");
const userRouter = require("./routes/User");
const authRouter = require("./routes/Auth");
const cartRouter = require("./routes/Cart");
const ordersRouter = require("./routes/Order");
const contactRouter = require("./routes/contact");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const { User } = require("./modle/User");
const LocalStrategy = require("passport-local").Strategy;
const crypto = require("crypto");
const { isAuth, sanitizaUser, cookieExtractor } = require("./server/Common");
const JwtStrategy = require("passport-jwt").Strategy;
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
const bodyParser = require("body-parser");
const FacebookStrategy = require("passport-facebook").Strategy;
const sendEmail = require("./server/Common");

// Stripe setup
const stripe = require("stripe")(process.env.STRIPE_SERVER_KRY);

// Middleware configurations
server.use(express.json({ limit: "10mb" }));
server.use(bodyParser.urlencoded({ limit: "100mb", extended: true }));
server.use(cookieParser());
server.use(cors({ exposedHeaders: ["X-Total-Count"] }));
server.use(express.urlencoded({ extended: true })); // Parse form data
server.use(bodyParser.json());

// Session setup
server.use(
  session({
    secret: process.env.SESSION_KEY,
    resave: false,
    saveUninitialized: false,
  })
);

// Passport initialization
server.use(passport.initialize());
server.use(passport.session());

// Static file serving for frontend
server.use(express.static(path.resolve(__dirname, "dist")));

// API routes
server.use("/products", productRouter.router);
server.use("/categories", categoriesRouter.router);
server.use("/brands", brandsRouter.router);
server.use("/users", isAuth(), userRouter.router);
server.use("/auth", authRouter.router);
server.use("/carts", isAuth(), cartRouter.router);
server.use("/orders", isAuth(), ordersRouter.router);
server.use("/contact", isAuth(), contactRouter.router);

// Payment routes
server.post("/create-payment-intent", async (req, res) => {
  const { totalAmount, orderId } = req.body;

  // Create a PaymentIntent with the order amount and currency
  const paymentIntent = await stripe.paymentIntents.create({
    amount: totalAmount * 100, // Decimal compensation
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    metadata: { orderId },
  });

  res.send({ clientSecret: paymentIntent.client_secret });
});

// Webhook route for Strip

server.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (request, response) => {
    const sig = request.headers["stripe-signature"];
    const endpointSecret = process.env.ENDPOINT_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
    } catch (err) {
      response.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    // Handle the event
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntentSucceeded = event.data.object;
        console.log({ paymentIntentSucceeded });
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    response.send();
  }
);

// Passport local and JWT strategies
passport.use(
  "local",
  new LocalStrategy(
    { usernameField: "email" },
    async (email, password, done) => {
      try {
        const user = await User.findOne({ email }).exec();
        if (!user) {
          return done(null, false, { message: "invalid credentials" });
        }
        crypto.pbkdf2(
          password,
          user.salt,
          310000,
          32,
          "sha256",
          async (err, hashedPassword) => {
            if (!crypto.timingSafeEqual(user.password, hashedPassword)) {
              return done(null, false, { message: "invalid credentials" });
            }
            const token = jwt.sign(
              sanitizaUser(user),
              process.env.JWT_SECRET_KEY
            );
            done(null, { id: user.id, role: user.role, token });
          }
        );
      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.use(
  "jwt",
  new JwtStrategy(
    {
      jwtFromRequest: cookieExtractor,
      secretOrKey: process.env.JWT_SECRET_KEY,
    },
    async (jwt_payload, done) => {
      try {
        const user = await User.findById(jwt_payload.id);
        if (user) {
          return done(null, sanitizaUser(user));
        } else {
          return done(null, false);
        }
      } catch (err) {
        return done(err, false);
      }
    }
  )
);

// Passport FaceBook strategies

passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_SECRET,
      callbackURL:
        "https://my-store-kappa-nine.vercel.app/auth/facebook/callback",
      profileFields: ["id", "displayName", "email"],
      scope: ["public_profile", "email"],
    },
    async function (accessToken, refreshToken, profile, cb) {
      try {
        // Extract email if available
        const email = profile.emails && profile.emails[0]?.value;

        // Log the profile data for debugging
        console.log("Facebook Profile:", profile);
        console.log("Extracted Email:", email);

        // Search for user in DB
        let user = await User.findOne({
          accountId: profile.id,
          provider: "facebook",
        });

        if (!user) {
          console.log("Adding new Facebook user to DB...");

          user = new User({
            accountId: profile.id,
            name: profile.displayName,
            email: email || null,
            provider: profile.provider,
          });

          await user.save();
          console.log("New user added:", user);
        } else {
          console.log("Facebook User already exists in DB:", user);

          // Update email if not already set
          if (!user.email && email) {
            user.email = email;
            await user.save();
            console.log("User email updated:", user.email);
          }
        }

        // Send login success email
        if (email) {
          const emailSubject = "Welcome to Dhicoins Exchange";
          const emailText = `Dear ${user.name}, you have successfully logged in to your Dhicoins account using Facebook. Enjoy our services!`;

          const emailHTML = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
              <img src="https://dhicoins.com/DhicoinIndex/images/dhicoins.png" alt="Dhicoins Logo" style="width: 160px; height: auto; margin: 0 auto; display: block;" />
              <h2 style="color: #333; text-align: center;">Welcome to Dhicoins Exchange</h2>
              <p style="margin-left: 18px;">Dear ${user.name},</p>
              <p>You have successfully logged in to your Dhicoins account using Facebook. Enjoy our services!</p>
              <p>Best Regards,<br>Dhicoins Team</p>
              <p style="color: #999; font-size: 12px; text-align: center; margin-top: 20px;">
                If you did not request this, please ignore this email.
              </p>
              <p style="color: #999; font-size: 12px; text-align: center;">
                &copy; ${new Date().getFullYear()} Dhicoins Exchange. All rights reserved.
              </p>
            </div>
          `;

          await sendEmail(email, emailSubject, emailText, emailHTML);
          console.log(`Login success email sent to ${email}`);
        } else {
          console.log("No email available to send the login success email.");
        }

        return cb(null, user);
      } catch (error) {
        console.error("Error in FacebookStrategy:", error);
        return cb(error, null);
      }
    }
  )
);

// Session serialization and deserialization
passport.serializeUser((user, cb) => {
  process.nextTick(() => cb(null, { id: user.id, role: user.role }));
});

passport.deserializeUser((user, cb) => {
  process.nextTick(() => cb(null, sanitizaUser(user)));
});

// Catch-all route for serving the frontend (this must be the last route)
server.get("*", (req, res) => res.sendFile(path.resolve("dist", "index.html")));

// Start the server
server.listen(process.env.PORT, () => {
  console.log("Server started on port " + process.env.PORT);
});
