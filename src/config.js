import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  sessionSecret: required('SESSION_SECRET'),
  databaseUrl: required('DATABASE_URL'),
  admin: {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
  email: {
    resendKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'vrtcls <hello@vrtcls.marketing>',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || 'hello@vrtcls.marketing',
    replyTo: process.env.EMAIL_REPLY_TO || 'hello@vrtcls.marketing',
  },
  companyAddress: process.env.COMPANY_ADDRESS || 'vrtcls, PO Box XXX, City, ST 00000',
  hitt: {
    autoBakeEnabled: process.env.AUTO_BAKE_ENABLED === 'true',
    notifyAdminOnNew: process.env.ADMIN_NOTIFY_ON_HITT !== 'false', // default ON
    notifyCustomerOnFulfill: process.env.CUSTOMER_NOTIFY_ON_FULFILL !== 'false', // default ON
    adminNotifyEmail: process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL,
  },
};

export const isProd = config.env === 'production';
