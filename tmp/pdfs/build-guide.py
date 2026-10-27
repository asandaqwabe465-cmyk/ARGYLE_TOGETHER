from pathlib import Path
import json
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF

ROOT=Path(__file__).resolve().parents[2]
settings=json.loads((ROOT/'tmp/pdfs/guide-settings.json').read_text())
CODE=settings['invitation_code']
URL='https://argyle-walk-together.sweet-cream-7564.chatgpt.site/'
OUT=ROOT/'output/pdf/Argyle-Together-Resident-Guide.pdf'
pdfmetrics.registerFont(TTFont('Arial','C:/Windows/Fonts/arial.ttf'))
pdfmetrics.registerFont(TTFont('ArialBold','C:/Windows/Fonts/arialbd.ttf'))
pdfmetrics.registerFontFamily('Arial',normal='Arial',bold='ArialBold',italic='Arial',boldItalic='ArialBold')
W,H=595.28,841.89
c=canvas.Canvas(str(OUT),pagesize=(W,H));c.setTitle('Argyle Together Resident Registration and App Guide');c.setAuthor('Argyle Together')
BLUE='#304CCA';INK='#15243A';MUTED='#58677B';PALE='#EEF2FF';LINE='#D8E0ED'
def box(x,y,w,h,fill=PALE,stroke=None,r=10):
 c.setFillColor(HexColor(fill));c.setStrokeColor(HexColor(stroke or fill));c.roundRect(x,H-y-h,w,h,r,fill=1,stroke=bool(stroke))
def text(t,x,y,size=12,bold=False,color=INK):
 c.setFillColor(HexColor(color));c.setFont('ArialBold' if bold else 'Arial',size);c.drawString(x,H-y-size,t)
def para(t,x,y,w,size=11.5,color=INK,leading=None):
 p=Paragraph(t,ParagraphStyle('p',fontName='Arial',fontSize=size,leading=leading or size*1.4,textColor=HexColor(color)));_,h=p.wrap(w,700);p.drawOn(c,x,H-y-h);return h

def head(page,title,sub):
 text('ARGYLE TOGETHER',36,27,11,True,BLUE);text('ARGYLE HOUSE',435,27,10,True,MUTED)
 text(title,36,64,27,True);para(sub,36,105,520,12,color=MUTED)
 c.setStrokeColor(HexColor(LINE));c.line(36,48,W-36,48)
 text('Resident guide  |  September 2026',36,805,9,color=MUTED);text(f'{page} / 4',526,805,9,color=MUTED)

def step(n,title,body,x,y,w):
 box(x,y,25,25,BLUE,r=12);text(str(n),x+8,y+3,12,True,'#FFFFFF');text(title,x+35,y+1,14,True);return 32+para(body,x+35,y+30,w-35)
def screen(x,y,w,title,rows,button=None):
 # Simplified UI illustration, not a screenshot or a live account.
 rowheights=[47 if len(v)<30 else 60 for k,v in rows]
 h=62+sum(rowheights)+(48 if button else 0)+16
 box(x,y,w,h,'#FFFFFF',LINE,15);box(x+9,y+9,w-18,27,PALE,r=6);text('argyle together',x+19,y+14,10,True,BLUE)
 text(title,x+15,y+43,12,True);pos=y+67
 for (k,v),rh in zip(rows,rowheights):
  text(k,x+15,pos,8.5,True,MUTED);box(x+15,pos+16,w-30,rh-23,'#F7F9FC',LINE,4);para(v,x+22,pos+19,w-44,9,leading=11);pos+=rh
 if button:box(x+15,pos+2,w-30,32,BLUE,r=6);para(button,x+22,pos+9,w-44,10,color='#FFFFFF',leading=12)
 return h

def notice(t,y,fill=PALE):
 h=para(t,50,y+13,495,11)+26;box(36,y,523,h,fill);para(t,50,y+13,495,11);return h

head(1,'Register your account','For Argyle House residents. Open the app, verify your own email, then complete your profile.')
box(36,155,523,115)
text('Open Argyle Together',52,170,17,True)
para('<link href="'+URL+'" color="'+BLUE+'"><b>Tap here to open the app</b></link>',52,199,360,12)
para('Or scan this QR code with your phone camera.',52,229,360,11,color=MUTED)
q=QrCodeWidget(URL);b=q.getBounds();d=Drawing(88,88,transform=[88/(b[2]-b[0]),0,0,88/(b[3]-b[1]),0,0]);d.add(q);renderPDF.draw(d,c,455,H-254)
text('Residence invitation code',36,290,13,True)
box(36,315,523,46,'#FFFFFF',LINE);text(CODE,51,326,17,True,BLUE)
para('Enter this shared code in <b>Residence invitation code</b> when registering. It is different from the private email code sent to your inbox.',36,371,523,11)
screen(36,433,236,'Join your neighbours',[('Email address','your email address'),('Residence invitation code',CODE)],'Send verification code')
screen(323,433,236,'Check your email',[('Email code','Enter your own 6-digit code')],'Verify &amp; continue')
para('<b>1.</b> Enter your email and the residence invitation code. Tap <b>Send verification code</b>.',36,699,245,11)
para('<b>2.</b> Check your inbox and spam folder. Enter the emailed code within <b>10 minutes</b>, then tap <b>Verify &amp; continue</b>.',313,663,246,11)
para('Keep your emailed code private. No personal verification code is printed in this guide.',313,735,246,10,color=MUTED)
text('Screen illustrations show the key controls; your layout may vary.',36,781,9,color=MUTED)
c.showPage()

head(2,'Complete your profile','Use your own details so residents can recognise you and coordinate their walk.')
screen(36,161,226,'Your Argyle House profile',[('Full name','Your full name'),('Cell phone number','Your contact number'),('Profile picture','Choose a clear photo'),('Location','Enable location permission')],'Save profile')
step(3,'Add your details','Enter your full name and cell phone number. Upload a <b>JPG, PNG or WebP</b> profile photo of up to <b>5 MB</b>.',286,165,273)
step(4,'Allow location','Tap <b>Enable location permission</b>, allow access on your phone and wait for a location reading. Then tap <b>Save profile</b>.',286,300,273)
para('<b>Want to volunteer?</b> Tick <b>I would like to become a volunteer escort</b> before saving. The organiser must approve your request before you can accept escorts.',36,531,523,11.5)
text('Add the app to your phone',36,612,18,True)
para('<b>iPhone:</b> Open the link in Safari. Tap <b>Share → Add to Home Screen → Add</b>. Open Argyle Together from its new icon.',36,648,248,11)
para('<b>Android:</b> Open the link in Chrome. Use the browser menu to choose <b>Install app</b> or <b>Add to Home screen</b>.',311,648,248,11)
para('<b>Turn on notifications:</b> Open <b>Install &amp; notifications</b>. Choose distress alerts and/or newly posted trips, tap <b>Enable notifications</b>, allow permission, then <b>Send me a test</b>. On iPhone, open the installed app first (iOS 16.4 or later).',36,716,523,11)
c.showPage()

head(3,'Plan and share a walk','All trip times are shown in Johannesburg time. Agree on a meeting point before leaving.')
step(1,'Post a trip','Choose <b>Trip board → Post a trip</b>. Enter your destination, starting point, future departure date and time, and any useful note. Tap <b>Post trip</b>.',36,159,285)
screen(346,158,213,'Post a trip',[('Destination','WEC'),('Starting point','Argyle House entrance'),('Departure','Choose date and time')],'Post trip')
step(2,'Join and chat','Open a trip with <b>View &amp; join</b>. Suggest a meeting point and tap <b>Ask to join</b>. Use <b>Trip conversation</b> to discuss plans. The owner confirms companions with <b>Accept partner</b>.',36,331,285)
box(36,506,523,115)
text('No replies after 20 minutes?',51,520,17,True,BLUE)
para('The owner can open the trip and tap <b>Request an escort</b>. A request is pending until security or an approved volunteer accepts it. The trip must still be open and its departure time must be in the future.',51,551,492,11)
para('<b>For approved escorts:</b> Open <b>Escort requests</b> and choose <b>Accept &amp; join walk</b>. You join the walk and chat automatically. The owner can tap your photo to view your escort profile.',36,644,523,11.5)
para('<b>During the walk:</b> The owner taps <b>Start walk</b>. Accepted participants can choose <b>Start location sharing</b>. Keep the app open and connected for updates. The owner taps <b>Finish walk</b> when done.',36,716,523,11)
c.showPage()

head(4,'Find your way around','Use the app menu to return to your trips, conversations and community updates.')
items=[('Trip board','Browse upcoming walks or post your own trip.'),('My trips','Open trips you posted or joined, including walks you accepted as an escort.'),('Trip history','Find previous plans, accepted companions and past conversations. The record does not verify who attended.'),('My profile','Update your details or check your volunteer application status.'),('Install & notifications','Install the app, choose alerts and send yourself a notification test.')]
y=160
for title,body in items:
 box(36,y,523,66,'#F5F7FC');text(title,50,y+9,12,True,BLUE);para(body,50,y+30,494,10.5);y+=76
text('Share a safety report',36,552,18,True)
para('Open <b>Safety reports</b> and describe what you personally observed, where and when. Confirm the statement and tap <b>Publish report now</b>. Reports appear as <b>Unverified community report</b>. Avoid victims\' names or private contact details. You can flag misleading or abusive reports.',36,583,523,11)
box(36,665,523,119,'#FFF0F1')
text('If you need urgent help',50,677,16,True,'#A32639')
para('Tap <b>Panic alert → Send distress alert now</b>. Your name, phone number, photo and available location are shared with registered residents. When safe, choose <b>I’m safe / close alert</b>.',50,705,495,10.5)
para('An alert does not dispatch emergency services or confirm help is coming. Contact residence security or emergency services directly if you can.',50,753,495,9.5,color='#802635')
c.showPage();c.save();print(str(OUT))
