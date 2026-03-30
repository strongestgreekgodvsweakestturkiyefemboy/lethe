# Lethe

Lethe is an open-source, self-hostable framework for **personal data sovereignty and archival**.
It enables users to exercise their right to data portability by interfacing with remote services
using their own **user-authorized session credentials** (never passwords). Designed as a
transparent "user agent," Lethe's microservices architecture allows individuals to securely migrate
their own digital history directly to private object storage (S3/MinIO). Lethe facilitates
interoperability through a Peer API, allowing users to manage their data across independent nodes
they control.

## Notes


Kinda lost interest in the project, but do open issues. I might fix them. Licence wise I don't care. Claim its yours, make money off it. idgaf

Kemono, Patreon and Discord importers work well. There a tag system too, but it's not actually wired up to anything useful (search, filters etc.)

First user created on website will be admin account.

I have tested Ansible deployment only on Arch servers and only the "site.yml" playbook. Large chance that minimal.yml won't work out of the box.
Ansible playbook doesn't currently make services auto start on reboot etc. too, so that would need to be fixed.

Required roles for minimal setup:
  * common
  * nginx
  * frontend
  * backend
  * importers
  * redis
  * minio
  * postgres



All requests are routed through caching proxy (nginx). 

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Ansible | ≥ 2.14 |
| A target Linux server | Arch 22.04+ recommended |
| SSH access to the target server | — |

The Ansible playbooks install every other dependency (Node.js, Python, pm2, PostgreSQL, Redis,
MinIO) on the target host automatically.



## Responsible Use

Lethe is a personal data-portability tool. It is designed exclusively to help **you** archive
**your own** data from services **you have authorized access to**.

- **Do not** use Lethe to access data belonging to other users.
- **Do not** use Lethe to bypass paywalls, access controls, or rate limits in a manner that
  violates a service's terms of use.
- **Do not** use Lethe to collect, store, or redistribute copyrighted material without the
  necessary rights.
- The developers of Lethe are not responsible for how end users deploy or operate the software.
  Users assume full legal responsibility for their own use.

Lethe's design aligns with the principles of GDPR Article 20 (right to data portability) and the
EU Data Act. Using Lethe to exercise your own data-portability rights is consistent with those
frameworks; using it to access or aggregate third-party data is not.

---

## Security

No guarantees. This is Proof of Concept project coded by AI. Absolutely zero security guarantees. 