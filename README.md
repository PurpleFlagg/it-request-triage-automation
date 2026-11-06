# IT Request Triage Automation

**Turning a jumbled request spreadsheet into an organized, self-monitoring queue for a small IT team, using Google Workspace.**

![Status](https://img.shields.io/badge/status-tested%20%26%20rolling%20out-blue) ![Platform](https://img.shields.io/badge/platform-Google%20Workspace-blue) ![Built with](https://img.shields.io/badge/built%20with-Apps%20Script-orange)

---

## Overview

I manage IT for a multi-site human services organization supported by a four-person IT team. Tech issues are reported by phone to our remote support agents by the people we serve, their support staff, or authorized family members. The agent fills out a short request form, which feeds a shared Google Sheet and sends an alert to a shared IT mailbox. Everything after that point was handled by hand.

I'm a big believer in simplifying processes so workloads are clearer and flow better through the day. This project replaced that manual process with a single organized queue that shows what's being requested, how urgent it is, how long it's been waiting, and whether it's a repeat request, and that reminds the team when something stalls.

## The Problem

Before building anything, I mapped the existing process. Intake was already automated: the form is linked to the tracking sheet, so new requests appear on their own. The real gap was everything that happened next:

- Every request landed in one long, unsorted list, with no ordering by priority
- Requests were described in a single free-text box, so it was hard to tell what kind of issue each one was
- The only alert was an email to a shared mailbox, so the team had to remember to go back and check it
- The only way to tell how long a request had been waiting was to look up when it was submitted
- Repeat requests about the same issue weren't connected, so it wasn't clear when someone had asked multiple times
- Requests that sat untouched had no follow-up

## Goals

- Keep the form quick for remote agents, who may be reporting an urgent situation
- Make the queue easy to scan, with urgent work clearly visible
- Show how long each request has been waiting
- Catch duplicate requests so repeat issues get attention
- Remind the team about requests that have stalled
- Keep a clean record of closed requests for compliance and review

## Tools Used

| Tool | Purpose |
|------|---------|
| Google Forms | Request intake by remote support agents |
| Google Sheets | Active request queue and resolved-request archive |
| Google Apps Script | Automation: sorting, color coding, duplicate checks, reminders, archiving |
| Gmail | Stale-request reminder emails to the shared IT mailbox |

## Design Decisions

I scoped the system around four key questions, plus a redesign of the form itself.

**1. Notification routing: who hears about a new request, and how?**
Decision: The sheet itself becomes the main queue. Requests are color-coded by priority, with urgent requests in red. Stalled requests get a 🔔 bell on their row and one reminder email to the shared IT mailbox.
Why: An email alone was easy to lose track of. Making the queue show what needs attention means no one has to remember which emails came in or dig through a jumbled list.

**2. Priority assignment: how is urgency decided?**
Decision: The remote support agent sets the priority (Urgent, High, Medium, or Low) when they take the call. The IT team can change it after reviewing the request.
Why: Urgency depends on the situation, not the type of request. A camera that isn't sending alerts can be urgent when monitoring keeps someone safe, while a password change may or may not be. Rigid categories wouldn't fit, so the agent's judgment comes first and IT can adjust it.

**3. Resolved-request handling: what happens when a request is closed?**
Decision: Setting a request's status to Resolved moves it automatically from the active queue to a Resolved tab, recording when it was resolved, who resolved it, and how many days it took.
Why: The active queue stays focused on open work, while closed requests stay documented for compliance reviews or leadership questions about response times.

**4. Follow-up flags: when does a request get flagged as stale?**
Decision: A request that hasn't changed status for 24 hours (Urgent) or 7 days (everything else) gets flagged with a bell and triggers a reminder. Any status change clears the flag. Requests on hold are never flagged, since they're waiting on something outside IT. A new request is marked as a duplicate when another unresolved request already exists for the same individual and the same issue type.
Why: Stalled requests were one of our biggest pain points. Duplicate flags also show when someone has had to ask more than once, which is a signal the issue needs attention.

**5. Form redesign: what should agents enter?**
Decision: I replaced the single free-text description with three fields: the individual's full name, an issue type dropdown listing the devices and systems we support, and a Notes box for details. IT has a separate Additional Notes column for updates while working a request.
Why: Structured fields make sorting and duplicate checking reliable, and a dropdown is faster for agents than writing a description from scratch. Separating the agent's notes from IT's notes keeps the original request intact.

## Workflow

```
Agent takes call → Form submitted → Copied into the Active Queue
        → Duplicate check (same individual + same issue, both unresolved)
        → Sorted by priority, oldest first (urgent = red)
        → IT reviews, adjusts priority if needed, updates status
           (New → Seen → In Progress / On Hold → Resolved)
        → Resolved → Moved to the Resolved tab with date, resolver, and days to resolve

Every hour: anything stalled past 24 hrs (urgent) or 7 days (other)?
        → 🔔 flag on the row + one reminder email to the IT mailbox
```

## How It's Built

- **The form-linked tab is never modified.** The script copies each submission into a separate Active Queue tab, so the raw record stays intact and the form connection can't break.
- **Three automatic triggers:** one runs when a form is submitted, one when someone changes a status, and one every hour to check for stalled requests. They're installable triggers, so they run with the sheet owner's permissions no matter who makes the edit.
- **Safe for a shared sheet.** The script uses a lock so two actions can't collide, and the hourly check only updates its own two columns so it never overwrites a teammate's notes.
- **Guardrails for setup.** If a setup step is skipped, the script stops with a plain-language message instead of mixing up data.
- **A one-time import** brought existing open requests into the new queue, keeping their status and notes.

I designed the requirements and workflow, tested the system, and deployed it. The script itself was written with AI assistance (Claude), which let me build a working automation without a programming background. The full script is in [`IT_Triage.gs`](IT_Triage.gs).

## Testing

I built and tested everything on a copy of the live sheet and form before touching the real system, working through a checklist:

- ✅ New submissions land in the queue, sorted and color-coded
- ✅ A second request for the same individual and issue is flagged as a duplicate, and the original is marked as a repeat
- ✅ Status changes are timestamped automatically
- ✅ Resolved requests move to the archive with resolution date, resolver, and days to resolve
- ✅ Stalled requests get a bell, and one reminder email is sent
- ✅ Changing a stalled request's status clears its bell

## Security and Privacy Considerations

- **Minimum necessary data:** the form collects no client identifiers beyond the name of the person who needs help, and staff look up other details in the organization's own systems.
- **Reminder emails contain no names,** only request IDs, issue types, priority, and days open. Details stay in the access-controlled sheet.
- **Least privilege:** sheet access is limited to the IT team.
- **Audit trail:** every resolved request is kept with who resolved it and when, supporting compliance reviews.
- **Change control:** all changes were tested on a copy before going live.

## Results

From testing on a copy of our live data:

- **26 open requests** were consolidated into one organized queue, sorted by urgency
- The first automated check flagged **6 urgent requests** that had stalled, one for more than three months
- Some open requests dated back **more than six months**, a gap the old process had no way to surface

*Results after two weeks of live use will be added here.*

## Related Tooling: IT Team Task Tracker

Alongside triage, I built an interactive task tracker in Google Sheets at my senior manager's request, so he could assign tasks to each team member and track progress in one place. I chose Sheets over a shared document because it handles assignment, status tracking, and manager visibility much better.

**What it does:**
- A main Tasks tab where the manager assigns work
- Automatically filled personal tabs for each team member
- Status dropdowns (Not Started, In Progress, Waiting, Done) with color coding
- Completed tasks move automatically to a Completed tab, keeping a history
- A companion Quick Reference Guide covers setup, daily use, and troubleshooting

**How it's built:** Google Apps Script with an installable edit trigger. Team members can only change their own task status, while the manager keeps full editing control.

**Iterating on feedback:** After my manager started using it, he asked to be able to assign tasks to himself too, so I added him to the assignment list with his own tab.

## What I Learned

- **Map the current process before automating.** I assumed form entries were being retyped by hand, but checking the form's settings showed intake was already automated. That pointed me to the real gap.
- **Design for the people filling out the form, not just IT.** Remote agents may be documenting an urgent situation, so the form should be quick for them while still giving IT clean, sortable data.
- **Test on a copy first.** Testing surfaced small issues, like a copied form needing its live link and a stray line pasted into the script, that were easy to fix before anyone depended on the system.
- **Automation permissions matter once you lock a sheet down.** In the task tracker, restricting teammates' edits broke the automation, because a simple trigger runs with the editor's permissions. Switching to an installable trigger fixed it.
- **Treat the process as a work in progress.** I started with these core features and plan to keep adjusting as new challenges come up.

## Repository Contents

```
├── README.md      ← This case study
└── IT_Triage.gs   ← The Apps Script (sanitized)
```

---

*Part of my IT and cybersecurity portfolio. All organization-specific and personal data has been removed.*
